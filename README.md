# TIC JAPAN · CopyTrade (MVP)

Copy-trading dashboard for TIC members. Built on **MetaApi** (cloud MT5 connection) + **CopyFactory** (MetaApi's managed copy-trading engine).

## Stack
Node 20 + Express 5, `metaapi.cloud-sdk` (provisioning, account info/positions), `metaapi.cloud-copyfactory-sdk` (strategies, subscribers, history). Storage: JSON file (`data/db.json`), passwords hashed with scrypt. Frontend: a single-page `public/index.html` (no build step).

## How it works
- **Admin** creates a *Strategy*: provisions the leader MT5 account with `copyFactoryRoles: ['PROVIDER']` (or reuses an existing MetaApi accountId), then calls `generateStrategyId` + `updateStrategy`.
- **Member** connects MT5 (login/password/server): the account is provisioned with role `SUBSCRIBER` and deployed. The MT5 password goes to MetaApi only and is **not stored** here.
- **Member settings** are mapped to `updateSubscriber` subscriptions: `multiplier`, `maxTradeVolume` (max lot), `symbolFilter.included`, `riskLimits` (lifetime balance-difference drawdown with `closePositions: true`), `removed` (copy on/off).
- **Dashboard**: balance/equity/positions via RPC connection; copied trades via `getSubscriptionTransactions`; leader stats via `getProvidedTransactions`.
- The first registered user (or `ADMIN_EMAIL`) becomes admin.

## Run
```
npm install
npm start                    # no token = DEMO/MOCK mode (sample data, nothing sent to MetaApi)
METAAPI_TOKEN=xxx npm start  # live
```
Env: `METAAPI_TOKEN`, `ADMIN_EMAIL`, `DATA_FILE`, `PORT`, `MOCK_MODE=1` to force mock.

## Getting a MetaApi token
Sign up at https://app.metaapi.cloud → API access / token page → generate a token with MetaApi + CopyFactory access. Then enable CopyFactory in your account. Never commit the token. Put it in Render env vars.

## Pricing note
MetaApi bills per deployed MT5 account per hour (plus a higher rate for CopyFactory-enabled accounts and the leader/strategy). The free tier is limited. Check https://metaapi.cloud/#pricing before onboarding many members. Undeploy unused accounts to save money.

## Deploy (Render)
`render.yaml` is included (starter plan + 1 GB disk for `db.json`). Set `METAAPI_TOKEN` and `ADMIN_EMAIL` in the dashboard.

## ⚠️ Disclaimer / regulation
Trading forex/CFD carries high risk; copy trading does not guarantee profit. Managing or copying trades for other people, or selling signals, may need a license. In Indonesia this is supervised by Bappebti/OJK, and other countries have their own regulators. Get legal advice before taking money from members. This software is provided as is.

## MVP limitations
JSON storage (move to Postgres for scale), no email verification or password reset, sessions never expire, leader stats in mock mode are sample data, and the dashboard opens an RPC connection per request (add caching/streaming for many users). Live mode has not been tested against a real token.
