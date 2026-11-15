# TMPrice (repository `repracer`)

A multi-tenant SaaS for professional marketplace sellers. For each seller it does three things:

1. **Reprices automatically.** Strategies compute prices that can never go below a mandatory floor: minimum price, margin floor and
   break-even. The only exception is an explicit, signed clearance mode.
2. **Synchronizes stock.** Stock comes from a shared pool or from the seller's own source and is published to every channel minus a
   per-channel buffer. We are not the owner of the stock.
3. **Explains and keeps every price.** Each decision has a permanent receipt ("Why this price"), and our own price history is kept per
   channel.

The product name shown to users is **TMPrice**. Technical names (`@repracer/*`, `REPRACER_*`, database names) stay `repracer` until
after the pilot.

> **Status (main, 2026-11-16): pre-launch, no live seller connected.**
> - Everything runs on simulators and synthetic data. The QA-A stand (`https://qa.tmprice.com`, behind Cloudflare Access) runs three
>   demo workspaces through the real decision path.
> - The Amazon developer profile is approved and the production app is registered (Draft). No seller has authorized it yet.
> - Amazon notifications part B is blocked by Amazon: the grantless scope answers `invalid_scope`, and a support case is open.
>   Competitor prices on Amazon therefore come from polling (`getCompetitiveSummary`).
> - No real seller data exists in tests, fixtures or logs. This is a project rule, not a circumstance.
>
> **The first paid MVP is Amazon US only** (owner decision Р-251). The eBay, Walmart and EU code is kept and still runs in CI, but new
> channel development is frozen.

The repository is **public but not open source** — see [LICENSE](LICENSE). Third-party material — [NOTICE.md](NOTICE.md).

## Channels

| Channel | State in `main` | Market profile |
|---|---|---|
| Amazon (SP-API) | Adapter built from the API model snapshot and checked against the static sandbox. Catalog from the listings report. Competitor prices from `getCompetitiveSummary` polling. Price write with read-back. Notifications receiver (part A) built; live subscription blocked. | `us` (amazon.com); amazon.de in `eu` |
| Walmart | Adapter against a channel model built from the owner's description of Walmart's rules: token bucket, feed limits, the uncompetitive-price rule. There is no spec snapshot and no keys yet. | `us` |
| eBay (Inventory API) | Adapter built from the developer sandbox; OAuth proven in the sandbox. Migration of old listings only with the owner's consent. | `us` (EBAY_US); EBAY_DE in `eu` |
| Kaufland | Adapter and simulator (DE/AT). Frozen with the EU profile. | `eu` only |

The market profile is a deployment setting (`REPRACER_MARKET_PROFILE`, default `us`). `us` hides Kaufland, EU storefronts, German and
the Omnibus screen without deleting anything; `eu` and `global` show them.

## What is implemented

- **Seller console** (`apps/console`, React). Its menu has nine items: Shadow mode, Price changes, Strategies, Costs & floors, Protections,
  Offers, Inventory, Channels, Stop pricing. Omnibus is a tenth item in the EU profile only. Every page shows its build in the footer.
  Languages are English, Spanish and French; German is available in the EU profile.
- **Decision path.** Input sanity checks lead to the strategy engine, then the Price Gate, then the database recheck before every send.
  Strategies: fixed price, target margin, beat the lowest, match / win the Buy Box. Options: anchor (Buy Box, lowest, lower of the two)
  and "compete with" (all, FBA, FBM).
- **Price fence.** Min and max price, margin floor, break-even, and clearance mode with MFA, a note and a checkbox. A raise toward the
  floor goes in a step ladder.
- **Shadow mode.** Every new channel account starts in shadow; going live is a separate owner action. A QA database cannot go live at
  all (live-write guard).
- **Three stops:** a person's emergency stop, a system halt on suspicious market data, and channel distrust. A single offer can also be
  turned off.
- **Imports and exports.** Imports are template-based, checked on the server and applied all-or-nothing: costs and fees, bounds,
  strategies, stock, product details. Exports exist on every data screen as CSV or XLSX, capped at 50,000 rows.
- **Stock sync:** a shared pool minus a channel buffer, orders turned into reservations, the Inbound API and returns.
- **Roles.** Owner and Manager have the same rights except billing, which does not exist yet. One login can belong to several
  workspaces, for example an agency.
- **Operator panel** (`apps/operator`). A separate, non-public process with five actions: create a tenant, invite its owner, mark a
  snapshot gap reviewed, mark an alert seen, accept a storefront day boundary.
- **Background processes:** scheduler, bulk-job worker, write dispatcher behind a Kafka-compatible broker, Amazon notification
  receiver, eBay account-deletion receiver.
- **Operations for the pilot** (`deploy/pilot`):
  - daily encrypted database copies that are pulled off the server and restore-checked;
  - external heartbeats (healthchecks.io) and an external `/healthz` monitor;
  - container logs kept for 12 months and pulled off the server;
  - rollback with a pre-migration copy;
  - a QA-B reset.

What is **not** implemented or is deferred is listed in [docs/deferred.md](docs/deferred.md). Billing and a mail provider are not
connected: e-mails are built but not sent (`DRY_RUN`).

## Architecture

```
            sellers (browser)                          operator (SSH tunnel)
                  │                                            │
        Caddy / Cloudflare Tunnel                        apps/operator (loopback only)
                  │                                            │
          apps/console ──── bulk-worker                        │
                  │               │                            │
                  ▼               ▼                            ▼
   ┌─────────────────────────── PostgreSQL 16 ───────────────────────────┐
   │ RLS (ENABLE + FORCE), tenant_id everywhere, append-only journals,    │
   │ floors re-checked before every send, roles separated per process     │
   └──────────────────────────────────────────────────────────────────────┘
          ▲                ▲                     ▲                    │
     scheduler      pricing-worker +      notification-receiver        │ daily export
   (polling, sweeps,  write dispatcher        (SQS)                     ▼
    discovery)      (Kafka-compatible broker)                  ClickHouse (≤ 18 months of
          │                │                                    channel data); tenant archive
          └──── channel adapters (ChannelAdapter port) ──── Amazon · Walmart · eBay · Kaufland
```

- **PostgreSQL is the only store the price decision reads.** Tenant isolation is shared schema plus row-level security, so no query
  crosses a tenant. Invariants such as both price bounds, append-only journals and column-level rights live in the database, not only
  in code. The full pattern is in [ADR-0003](docs/adr/0003-tenant-isolation.md) and [ADR-0004](docs/adr/0004-storage-tiering.md).
- **One write unit per field** (`write_scope`): versions, idempotency and ordering are kept per account × storefront × item × field
  ([ADR-0002](docs/adr/0002-write-scope-per-field.md)). A write is never lost silently: it is either sent or discarded with a reason.
- **Sign-in is external** (ZITADEL in production profiles). We store only the issuer/subject mapping to memberships and roles.
  The QA-A stand uses a simulated sign-in behind Cloudflare Access.
- **Channel adapters** describe their channel as data and classify errors. They never decide about retries or versions
  ([ADR-0006](docs/adr/0006-channel-port.md)). Facts about channel APIs come only from dated snapshots in [vendor/](vendor/).

## Environments

| Environment | Where | What runs | State |
|---|---|---|---|
| QA-A | `deploy/qa`, `https://qa.tmprice.com` behind Cloudflare Access | Stand with the three demo workspaces on the simulator, bulk-job worker, PostgreSQL with the live-write guard | Running; manual QA |
| QA-B | `deploy/pilot` on a temporary machine (`REPRACER_PILOT_STAND=qa-b`) | The pilot stack with real sign-in, operator panel, scheduler, backups and monitoring | Code ready; machine not bought yet |
| Pilot | `deploy/pilot` on its own server | First production: console, scheduler, bulk worker, operator panel, PostgreSQL, ClickHouse, tunnel; shadow only, no broker | Code ready; server bought at launch |
| Production profile | `deploy/production` and the per-process `deploy/*` folders | Full profile with TLS proxy, broker, receivers | Exercised by CI |

## Repository layout

| Path | Purpose |
|---|---|
| [apps/](apps/) | `console` (seller console and its server), `operator` (operator panel), `landing` (static site) |
| [packages/](packages/) | 26 packages: decision path (`input-sanity`, `strategy-engine`, `price-gate`, `pricing-pipeline`), storage (`pricing-store-pg`), channel clients and adapters, `stock-sync`, `bulk-jobs`, `identity`, `channel-oauth`, `alert-delivery`, `console-model` |
| [services/](services/) | `scheduler`, `pricing-worker`, `notification-receiver`, `ebay-account-deletion` |
| [migrations/](migrations/) | PostgreSQL DDL: 207 migrations (last `0232`); schema checks are migrations too (latest `0228`, v68) |
| [schemas/clickhouse/](schemas/clickhouse/) | ClickHouse DDL |
| [tests/db/](tests/db/) | Schema smoke tests and the mutation catalog |
| [tests/contract/](tests/contract/) | Contract stand (record/replay), channel simulators, backtest, chaos and scale runs |
| [deploy/](deploy/) | Deployments: `qa`, `pilot`, `production`, one folder per process, CI overlays |
| [vendor/](vendor/) | Dated snapshots of channel and service documentation with SHA-256 |
| [docs/](docs/) | Decisions, ADRs, evidence, runbooks, the FDD |

## How it is checked

- **Red first.** A change starts with a test that fails on the old code.
- **Mutation check of the schema.** Every database protection is removed one at a time, and each must be caught by *its own* check
  with *its own* reason. Last nightly run (2026-11-15): 888 mutations, 0 uncaught.
- **Live runs through HTTP like a browser** on a 10,000-offer catalog, with response time and size asserted. There are also chaos runs
  (processes killed mid-batch), a 50,000-offer scale run, a simulated demo day and a shadow day.
- **Two CI lanes and a nightly full run** ([ADR-0066](docs/adr/0066-two-ci-lanes-and-nightly-full-run.md)):
  - the lane is chosen from the diff;
  - merging is a fast-forward of a verified commit through `scripts/merge-when-green.mjs`;
  - `main` is protected on GitHub, including against admins;
  - a red night opens an issue and stops merges.
- **A finding is closed by a rule where possible**, not only by a fix. The repository rules live in `scripts/test/*.test.ts`.

## Development

Requirements: Node ≥ 22.3 and PostgreSQL 16. There are five runtime dependencies: `pg`, `@confluentinc/kafka-javascript`, `react`,
`react-dom` and `@fontsource/ibm-plex-mono`.

```sh
npm ci
npm run typecheck

# a clean test database (re-created; never run on a database with data)
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres scripts/db/prepare.sh repracer_eu

# tests — a skipped test is a red build
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres REPRACER_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
  node scripts/test-all.mjs --scope=fast        # scopes: fast, full, long, shadow, chaos, scale

node scripts/db/mutation-check.mjs --jobs 3      # schema mutation check (long)

# local stand: simulated sign-in, scenario worlds
npm run stand -w @repracer/console               # API http://127.0.0.1:4318
npm run dev -w @repracer/console                 # console http://127.0.0.1:5173

scripts/demo-prepare.sh                          # the demo for a client walkthrough (docs/demo-script.md)
```

## Documentation

Product and QA documents are in English; internal engineering documents are in Russian; identifiers are in English.

| Document | What it is |
|---|---|
| [docs/TMPRICE_FDD.md](docs/TMPRICE_FDD.md) | Functional design: what the product does, with a QA-A / QA-B / LIVE / DEFERRED label on every function |
| [CLAUDE.md](CLAUDE.md) | Project context: step-by-step status, channel constraints, working rules (Russian) |
| [docs/decisions.md](docs/decisions.md) | Product owner decisions Р-1…Р-252 |
| [docs/adr/](docs/adr/) | 77 architecture decision records |
| [docs/deferred.md](docs/deferred.md) | What is deferred, why, and when it comes back |
| [docs/open-questions.md](docs/open-questions.md), [docs/accepted-risks.md](docs/accepted-risks.md) | What is unknown, and what was decided not to close |
| [deploy/qa/README.md](deploy/qa/README.md), [deploy/pilot/README.md](deploy/pilot/README.md) | QA-A and pilot / QA-B runbooks |
| [docs/live-first-account-checklist.md](docs/live-first-account-checklist.md) | The first day with a live Amazon account |
| [docs/evidence/](docs/evidence/) | Logs and analyses behind each step's claims |
