// TIC JAPAN CopyTrade — MVP. MetaApi + CopyFactory. Mock mode when METAAPI_TOKEN is absent.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.METAAPI_TOKEN || '';
const MOCK = !TOKEN || process.env.MOCK_MODE === '1';
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@tic.jp').toLowerCase();
const PORT = process.env.PORT || 3000;

// ---------- storage (JSON file) ----------
fs.mkdirSync(path.dirname(DATA), { recursive: true });
let db = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : { users: [], sessions: {}, strategies: [] };
const save = () => fs.writeFileSync(DATA, JSON.stringify(db, null, 2));
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const verify = (pw, stored) => { const [s, h] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, s, 64)); };

// ---------- MetaApi layer ----------
let api, cf;
if (!MOCK) {
  const MetaApi = require('metaapi.cloud-sdk').default;
  const CopyFactory = require('metaapi.cloud-copyfactory-sdk').default;
  api = new MetaApi(TOKEN);
  cf = new CopyFactory(TOKEN);
}
const rnd = (a, b) => +(a + Math.random() * (b - a)).toFixed(2);
const mock = {
  info: (seed = 1) => ({ balance: 10000 * seed, equity: +(10000 * seed + rnd(-150, 320)).toFixed(2), margin: rnd(80, 400), currency: 'USD', leverage: 500 }),
  positions: () => [
    { id: '7001', symbol: 'XAUUSD', type: 'POSITION_TYPE_BUY', volume: 0.2, openPrice: 2651.4, currentPrice: 2658.9, profit: 150.0 },
    { id: '7002', symbol: 'USDJPY', type: 'POSITION_TYPE_SELL', volume: 0.5, openPrice: 151.32, currentPrice: 151.18, profit: 46.3 },
    { id: '7003', symbol: 'EURUSD', type: 'POSITION_TYPE_BUY', volume: 0.3, openPrice: 1.0912, currentPrice: 1.0897, profit: -45.0 },
  ],
  history: () => Array.from({ length: 8 }, (_, i) => ({
    id: 'T' + (9000 + i), time: new Date(Date.now() - i * 5.3e6).toISOString(),
    symbol: ['XAUUSD', 'USDJPY', 'EURUSD', 'GBPJPY'][i % 4], type: i % 3 ? 'DEAL_TYPE_BUY' : 'DEAL_TYPE_SELL',
    volume: [0.1, 0.2, 0.3][i % 3], profit: [84.2, -32.1, 120.5, 41.0, -18.4, 66.7, 12.3, -9.9][i], strategy: 'TIC Gold Leader' })),
  leaderPerf: () => ({ gain: 38.4, monthly: [4.1, 6.3, -1.2, 8.7, 5.5, 3.9, 7.0], winRate: 68, maxDD: 9.8, trades: 412 }),
};

async function provisionAccount({ login, password, server, name, role }) {
  if (MOCK) return 'mock-' + crypto.randomBytes(6).toString('hex');
  const acc = await api.metatraderAccountApi.createAccount({
    name, type: 'cloud', login: String(login), password, server, platform: 'mt5',
    magic: 0, copyFactoryRoles: [role], // PROVIDER for leader, SUBSCRIBER for members
  });
  await acc.deploy();
  return acc.id;
}
async function accountSnapshot(accountId) {
  if (MOCK || accountId.startsWith('mock-')) return { info: mock.info(), positions: mock.positions(), state: 'DEPLOYED (mock)' };
  const acc = await api.metatraderAccountApi.getAccount(accountId);
  if (acc.state !== 'DEPLOYED') return { info: null, positions: [], state: acc.state };
  const conn = acc.getRPCConnection();
  await conn.connect(); await conn.waitSynchronized({ timeoutInSeconds: 30 });
  const [info, positions] = await Promise.all([conn.getAccountInformation(), conn.getPositions()]);
  return { info, positions, state: acc.state + ' / ' + acc.connectionStatus };
}
function subscriptionFor(u) {
  const s = u.settings;
  return db.strategies.filter(st => !st.removed).map(st => ({
    strategyId: st.id, multiplier: s.multiplier, maxTradeVolume: s.maxLot || undefined,
    symbolFilter: s.symbols.length ? { included: s.symbols } : undefined,
    riskLimits: s.maxDD ? [{ type: 'lifetime', applyTo: 'balance-difference', maxRelativeRisk: s.maxDD / 100, closePositions: true }] : undefined,
    removed: !s.enabled,
  }));
}
async function syncSubscriber(u) {
  if (MOCK || !u.accountId) return;
  await cf.configurationApi.updateSubscriber(u.accountId, { name: u.email, subscriptions: subscriptionFor(u) });
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(500).json({ error: e.message }));
const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const u = db.users.find(x => x.id === db.sessions[t]);
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u; next();
};
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const pub = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, accountId: u.accountId, mt5: u.mt5, settings: u.settings });

app.get('/api/status', (req, res) => res.json({ mock: MOCK }));
app.post('/api/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 8) return res.status(400).json({ error: 'Email & password (min 8) required' });
  if (db.users.find(u => u.email === email.toLowerCase())) return res.status(400).json({ error: 'Email sudah terdaftar' });
  const u = { id: crypto.randomUUID(), email: email.toLowerCase(), name: name || email.split('@')[0], pw: hash(password),
    role: (email.toLowerCase() === ADMIN_EMAIL || !db.users.length) ? 'admin' : 'member', accountId: null, mt5: null,
    settings: { enabled: false, multiplier: 1, maxLot: 1, maxDD: 20, symbols: [] } };
  db.users.push(u); save(); res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const u = db.users.find(x => x.email === (req.body.email || '').toLowerCase());
  if (!u || !verify(req.body.password || '', u.pw)) return res.status(401).json({ error: 'Email atau password salah' });
  const t = crypto.randomBytes(32).toString('hex'); db.sessions[t] = u.id; save(); res.json({ token: t, user: pub(u) });
});
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

app.post('/api/mt5/connect', auth, wrap(async (req, res) => {
  const { login, password, server } = req.body;
  if (!login || !password || !server) return res.status(400).json({ error: 'Login, password, server wajib' });
  const id = await provisionAccount({ login, password, server, name: 'TIC member ' + req.user.email, role: 'SUBSCRIBER' });
  req.user.accountId = id; req.user.mt5 = { login: String(login), server, platform: 'mt5' }; save(); // password NOT stored
  res.json(pub(req.user));
}));
app.put('/api/settings', auth, wrap(async (req, res) => {
  const b = req.body, s = req.user.settings;
  s.enabled = !!b.enabled; s.multiplier = Math.max(0.01, Math.min(10, +b.multiplier || 1));
  s.maxLot = Math.max(0, +b.maxLot || 0); s.maxDD = Math.max(0, Math.min(100, +b.maxDD || 0));
  s.symbols = (Array.isArray(b.symbols) ? b.symbols : String(b.symbols || '').split(',')).map(x => x.trim().toUpperCase()).filter(Boolean);
  save(); await syncSubscriber(req.user); res.json(pub(req.user));
}));
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const u = req.user;
  const snap = u.accountId ? await accountSnapshot(u.accountId) : { info: null, positions: [], state: 'NOT CONNECTED' };
  let history = [];
  if (u.accountId) {
    if (MOCK) history = mock.history();
    else history = (await cf.historyApi.getSubscriptionTransactions(new Date(Date.now() - 30 * 864e5), new Date(), undefined, [u.accountId]))
      .map(t => ({ id: t.id, time: t.time, symbol: t.symbol, type: t.type, volume: t.volume, profit: t.profit, strategy: t.strategy && t.strategy.name }));
  }
  const leaders = db.strategies.filter(s => !s.removed).map(s => ({ id: s.id, name: s.name, description: s.description, perf: mock.leaderPerf(), perfIsSample: true }));
  if (!MOCK) for (const l of leaders) {
    try {
      const tx = await cf.historyApi.getProvidedTransactions(new Date(Date.now() - 30 * 864e5), new Date(), [l.id]);
      const wins = tx.filter(t => t.profit > 0).length;
      l.perf = { trades: tx.length, winRate: tx.length ? Math.round(wins / tx.length * 100) : 0, profit30d: +tx.reduce((a, t) => a + (t.profit || 0), 0).toFixed(2) };
      l.perfIsSample = false;
    } catch { }
  }
  res.json({ user: pub(u), ...snap, history, leaders, mock: MOCK });
}));

// ---- admin ----
app.get('/api/admin/overview', auth, admin, (req, res) => res.json({ strategies: db.strategies.filter(s => !s.removed), members: db.users.map(pub), mock: MOCK }));
app.post('/api/admin/strategy', auth, admin, wrap(async (req, res) => {
  const { name, description, login, password, server, accountId: existing } = req.body;
  let accountId = existing;
  if (!accountId) accountId = await provisionAccount({ login, password, server, name: 'TIC leader ' + name, role: 'PROVIDER' });
  let id = MOCK ? crypto.randomBytes(2).toString('hex').toUpperCase() : (await cf.configurationApi.generateStrategyId()).id;
  if (!MOCK) await cf.configurationApi.updateStrategy(id, { name, description: description || name, accountId });
  db.strategies.push({ id, name, description, accountId, leaderLogin: login || null, server: server || null, created: new Date().toISOString() });
  save();
  for (const u of db.users) await syncSubscriber(u).catch(() => {});
  res.json({ ok: true, id });
}));
app.delete('/api/admin/strategy/:id', auth, admin, wrap(async (req, res) => {
  const s = db.strategies.find(x => x.id === req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  if (!MOCK) await cf.configurationApi.removeStrategy(s.id);
  s.removed = true; save(); res.json({ ok: true });
}));

app.get('/{*any}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`TIC CopyTrade on :${PORT} ${MOCK ? '(MOCK MODE — set METAAPI_TOKEN for live)' : '(LIVE MetaApi)'}`));
