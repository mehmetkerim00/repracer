# TMPrice — Functional Design Document

Nov 25, 2026 · @ITdzen · Status: living document, updated as the product evolves. This version is reconciled with `main` after step 175.
The QA-A stand runs `main`; the footer of every page names the exact build (`Build <sha> · <time>`). Since step 146 the console is being
redesigned issue by issue (#34, #24, #27, #29, #25, #26, #28, then the proposals #36, #35, #34 tier 2); the theme is "Spruce Hybrid" (step 167).

## How to read the labels

Every function carries exactly one label. Descriptive sections (overview, concepts, engineering, glossary) carry none.

| Label | Meaning |
|---|---|
| **[QA-A]** | Implemented; testable now on QA-A (`https://qa.tmprice.com`): three demo workspaces on the channel simulator, simulated sign-in |
| **[QA-B]** | Implemented; can only be checked on QA-B (the pilot stack on a temporary machine): real sign-in, operator panel, scheduler, channel connection flow, backups and monitoring |
| **[LIVE]** | Implemented; needs a real Amazon integration: seller authorization, notifications part B, live limits, live listing data |
| **[DEFERRED x]** | Not implemented or deferred; `x` is the row in [docs/deferred.md](deferred.md) (row names are listed in § 15) |

## 1. Product overview

TMPrice is a repricing and inventory-synchronization service for professional marketplace sellers on Amazon, Walmart and eBay (US
market first). It computes and sends prices for every listing, keeps stock in sync across channels, and makes every single decision
fully auditable. That last trait is what defines it.

The product is built on three promises:
- **Every price is explained.** Each change opens as a decision record (a "receipt"): which competitor moved, what the strategy
  computed, which safety checks passed, what was sent to the store. A seller answers "why is this $18.40?" in seconds.
- **Selling at a loss by accident is impossible.** Break-even (unit cost + marketplace fees) is always part of the price floor. The
  floor is enforced in the database, so no code path can bypass it. Deliberate below-cost clearance exists, but only behind an
  explicit signed confirmation.
- **Nothing can be rewritten.** Every decision, stop, role change, import and export lands in an append-only journal that nobody —
  including platform operators — can edit or delete.

Target users: professional sellers who have been burned by black-box repricers, and agencies that manage several seller businesses
under one login. Delivery: a web console ("seller console") in English, Spanish and French (German behind the EU profile).

**Scope of the first paid MVP: Amazon US only** (Р-251). The eBay, Walmart and EU code is kept and still runs in CI; new channel
development is frozen until the owner decides otherwise.

Client and pilot workspaces see Amazon US only (Р-256):
- the console offers only amazon.com to connect and names no other channel on any screen;
- the database refuses any other channel account or connection for a client workspace.

The demo workspaces keep amazon.com, walmart.com and ebay.com: it is a simulator storefront, and QA retests run on it.

Current status (Nov 16, 2026): pre-launch.
- The Amazon developer profile is approved and the production app is registered (Draft). No seller has authorized it yet.
- QA-A is live for manual QA.
- The pilot and QA-B stacks exist as code; their servers are bought at launch with Merdan's approval.
- No live seller is connected.

## 2. Roles and access

Two real roles, deliberately simple. The only difference between them is money.

| Function | What it does | Label |
|---|---|---|
| Owner | Everything: pricing, strategies, floors, imports, stops, team, channel accounts, going live, plus billing and money matters (billing itself is not built, see below) | **[QA-A]** |
| Manager | Everything except money: full day-to-day control of pricing, strategies, floors, imports, stops, team, channel accounts and going live. Cannot change the Owner's role or sign-in | **[QA-A]** |
| Several workspaces under one login | One login can hold different roles in different businesses. With one workspace the console signs straight into it; with several, a workspace list is shown, and "All workspaces" is always reachable at `#/workspaces` | **[QA-A]** |
| Real sign-in | External identity provider (ZITADEL), code flow with PKCE, invitations accepted after sign-in. No passwords or sessions are stored by us | **[QA-B]** |
| Second-factor policy | A second factor is demanded only from actions that move the "price fence": costs and bounds of many offers, below-cost clearance, resuming a whole-workspace stop, going live. Inside the fence (assigning strategies, stopping pricing, imports that respect the fence, turning one offer off) no second factor is asked. QA-A signs everyone in *with* a second factor, so refusals without it can only be seen on QA-B | **[QA-B]** |
| Demo guest | Read-only walk through a demo workspace ("View demo"): no change, no job, no export. The refusals come from the database. Built, but no stand serves it: QA-A has no guest sign-in, and the pilot runs with the public demo off | **[DEFERRED 135 (guest)]** |
| Billing | Owner-only money matters; invoices go out by hand for the pilot | **[DEFERRED 135 (billing)]** |

## 3. Core concepts

The data model in one pass, top-down:
- **Workspace** — one seller business with its own channel accounts, team and journals. Complete tenant isolation: no data crosses
  workspaces.
- **Channel account** — one connection to one marketplace (an Amazon seller account, an eBay account). Runs in shadow or live mode.
- **Storefront** — a marketplace site within a channel (amazon.com, walmart.com). All amounts on screen are in the storefront's
  currency; a foreign-currency offer never masquerades as dollars.
- **Product** — the seller's item: SKU, title, unit cost, an optional color word. One product can be offered on several channels.
- **Offer** — one product on one storefront: price, status, strategy, bounds, fulfillment (FBA/FBM), automatic pricing on or off.
- **Strategy** — a named, versioned pricing rule in plain words ("undercut by $0.01 against the winner price with shipping"). Every offer
  prices by exactly one pinned strategy version.
- **Price fence** — the hard limits a strategy can never cross: minimum price, margin floor, break-even, maximum price. The effective
  floor is the highest applicable floor, enforced in the database.
- **Clearance** — a deliberate per-offer exception that replaces the whole floor with a clearance floor (may be below cost). Returns to
  normal pricing by a step ladder, never by a jump.
- **Decision record** — the permanent "receipt" of one price decision.
- **Journals** — append-only logs of everything. Every journal screen exports like any other.
- **Shadow mode** — the engine runs fully but sends nothing to the store. Every new channel account starts in it.

## 4. Console screens

Every data screen shares the same conventions:
- storefront chips instead of long channel names;
- server-side filters and pages;
- an Export button (CSV/XLSX);
- a "Why this price" link wherever a price appears;
- the build (`Build <sha> · <time>`) in the footer of every page.
- a status line on top of every workspace screen: pricing mode, active stops, freshness of competitor data, and the offers that need
  attention — each number opens its own selection;
- a row that needs attention is tinted yellow — only for a real reason: on Offers the reasons the status line counts, on Inventory the
  rule of its "needs attention" filter.

| Screen | What it shows | What the seller does there | Label |
|---|---|---|---|
| Overview | The first menu item. Four questions since your last visit (a visit is opening Overview at least 30 minutes after the one before; with no earlier visit — the last 24 hours, and it says so): is everything working (the status line parts); what changed and why (price decisions grouped by one stored cause each — stops, data quality, floor holds, strategy change, unit cost and fees, competitors, other — with decisions and unique offers; a click opens the decision journal filtered by that cause, with the same number); where is the risk (dangerous proposals stopped by bounds, stale competitor data); what needs action (the status-line attention reasons plus clearance on and offers below break-even). Every number opens the selection of the same window | Starts the day: sees what happened and where to look | **[QA-A]** |
| Sign-in / Workspaces | The businesses this login belongs to, with role and live counters | One workspace — signs straight in; several — picks one | **[QA-A]** |
| Shadow mode | A "Ready to send prices?" checklist on every account in shadow: what stops the switch to live (the same rules the switch enforces) apart from what is worth fixing first; every item opens its own Offers selection with the same number, and the switch button stays off with its reason while anything stops it. Everything the engine would have sent, held back; decisions per day; "N price reductions your floor prevented; $X in aggregate proposed price differences — not realized profit" (events, unique SKUs and sum by the same definition as Protections); the weekly e-mail as a preview | Reviews decisions during the trial week. On a QA database the switch to live is refused, and the screen names the reason before any attempt | **[QA-A]** |
| Price changes | One journal of every price sent or held, and of every decision behind it: from → to, status, reason, trigger chip ("Seller ↓ $12.50"). A repeated "no change" is one row with a counter | Audits activity; opens any row's receipt | **[QA-A]** |
| Why this price | The full decision record of one change (§ 5): a summary card first (trigger, proposed price, decision, sending to your store), the seven stations folded behind "Show full evidence" — open by themselves for a rejection or a pause | Reads the receipt; follows links to bounds and floors | **[QA-A]** |
| Why didn't my price change? | For one offer and a period (up to 30 days): the receipt sentence of its latest stored decision with its status pill, since when the same stored reason runs, how many checks followed, the last price change of the period; the receipt and the period's decisions folded below. With no decision in the period it says so and explains when decisions are recorded — no reason is guessed after the fact | Opens it from the Offers row, the offer page, or an empty Price changes selection with an offer chosen | **[QA-A]** |
| Strategies | Strategies in plain words, their versions, which offers each prices, a preview before saving | Creates new versions, assigns offers, previews | **[QA-A]** |
| Default strategy for new offers | Per channel account (on Channels): "None" or an active strategy available on that channel | Sets it. It assigns the latest active version to newly discovered offers, but never enables sending; every auto-assignment traces back to the person who set the default | **[QA-A]** |
| Costs & floors | Unit costs, min/max prices and, next to them, the effective floor with its source (it can be above your minimum: margin, break-even), margin floor, break-even, clearance; the marketplace's own Min/Max next to ours with conflict warnings (where the values are known) | Edits costs and bounds (second factor for many offers); sees which floor is effective and why | **[QA-A]** |
| Protections | What stopped or prevented changes: floor holds ("120 price reductions prevented by your floor; $589.70 in aggregate proposed price differences", with Events / Unique SKUs / Sum; one event is one hold, however many times the price was re-checked while it lasted), stops by people, rules. Each row has one status from the shared vocabulary: Adjusted to limit, Rejected (dangerous when over 10% beyond a bound), Blocked | Reviews what the fence earned; opens each hold's receipt | **[QA-A]** |
| Offers | Every offer: status ("On · shadow mode" in the trial), current price, margin at that price, health (errors and blocks, the most important first with what to do; every reason that marks a row yellow is named in Health), strategy, effective floor, color; optional Buy Box columns (holder, price, gap, Buy Box share (7 days)); compact rows are the standard and always show the color and the channel ID; "Showing N of M offers" when filtered; "Repricing: On / Off", "Needs attention", "Setup" (no strategy; no minimum or maximum price) and "Money" (clearance on; below break-even) filters | Filters, sorts, bulk edits, exports offers and competitors | **[QA-A]** |
| Turn off one offer | "Turn off" / "Enable" per offer (Owner or Manager, no second factor, optional note); "Turned off by …" on the row. A turned-off offer is not evaluated, and its queued writes are not sent | Pauses one SKU without stopping anything else | **[QA-A]** |
| Competition | Per offer: Buy Box holder, place and gap, Buy Box share 24h / 7d / 30d by snapshots, "Why not in the Buy Box", the Amazon competitive summary with coupons and buyer-segment groups | Understands the market around one offer | **[QA-A]** |
| Inventory | One shared stock pool per product, minus a safety buffer, fed to every channel; each channel line names its calculation with the saved buffer, cap and minimum to list (e.g. "58 to publish = 60 available − buffer 2"); reservations; what was published and confirmed; divergence; returns to decide on; filters by channel and "needs attention"; sort by reserved, and by "To publish" within a chosen channel; a preview of what a channel would get before enabling | Sets buffers, imports stock, accepts or rejects returns | **[QA-A]** |
| Channels | Channel accounts, shadow/live state, "other tools" question, external edits counter, default strategy | Watches sync health | **[QA-A]** |
| Stop pricing | The emergency brake and the audit log (stops, roles, channel events, exports) | Stops a channel account, a storefront or the whole workspace with a note; resumes | **[QA-A]** |
| Omnibus | Lowest prior price per EU storefront (30 days) as evidence for discounts | — (EU profile only) | **[DEFERRED 135 (EU)]** |

## 5. The pricing engine

**Decision path — [QA-A].** Every price decision passes seven stations, in order. Each station records its own verdict into the
decision record; a failure at any station stops the change and says why.

1. **Competitor snapshot.** What the marketplace reported at that moment: source, observation time, every competitor with price
   including shipping, who held the Buy Box. Competitor details stay with the decision for 30 days; the decision itself is kept forever.
2. **Input check — 9 rules.** Is this snapshot trustworthy?
   - storefront not halted;
   - structure sane: amounts, currency, price basis;
   - fresh and in order;
   - no mass price shift across the storefront;
   - no decimal-point error (×100 / ×0.01);
   - plausibility anchors available.
3. **Plausibility anchors.** The snapshot is cross-checked against independent anchors: unit cost, internal consistency, the same EAN on
   another channel (if seen within 168 h), own price history.
4. **Strategy.** The assigned strategy version computes a proposal and shows its arithmetic in one sentence ("The Buy Box costs the buyer
   $18.43 with shipping; $0.01 below it: $18.42").
   - Strategy types: fixed price, target margin, beat the lowest, match the Buy Box, win the Buy Box.
   - Options: anchor on the Buy Box price, the lowest price, or the lower of the two; compete with all sellers, FBA only or FBM only;
     step back up while winning.
5. **Price gate — 13 checks.** The fence:
   - pricing not stopped by a person;
   - offer active and on automatic pricing;
   - channel applies our prices as sent;
   - proposal valid and not expired;
   - min and max set;
   - margin floor computed;
   - not below the effective floor;
   - not above the ceiling;
   - step within limit;
   - change frequency within limit;
   - final bound recheck.
6. **Sending.** The approved price goes to the store (or is held by shadow mode), with version and attempt count. The database
   recomputes the floor before *every* send, with current cost, fees, exchange rate and tax.
7. **Channel confirmation.** The store's acknowledgement closes the loop; mismatches are surfaced, never papered over.

**Guards below the code.** Floors and append-only journals are enforced by the database itself (CHECK constraints, triggers, row-level
security). A bug in application code cannot sell below the floor or rewrite history.

Special cases, handled honestly:

| Function | Behavior | Label |
|---|---|---|
| Clearance (deliberate loss) | Replaces the whole floor with a clearance floor; second factor + note + checkbox; the loss per piece and the largest total loss are shown before confirming; turns on only when break-even is computed — otherwise the clearance section shows only «Loss cannot be calculated — add unit cost and fees first» with a link to the unit cost import (no form, no checkbox; step 174), and the database refuses it (step 140); outside clearance the floor always includes break-even; turning it off returns to the floor by a step ladder | **[QA-A]** |
| Raise toward the floor | When the floor rises (cost, fee, min price, margin), a price below it climbs in steps no larger than the step limit, at most one step per scheduled period, with "about N steps left"; the owner is notified once per ladder. The ladder is driven by the scheduled recompute, which the demo runs every 15 minutes for its ebay.com and walmart.com offers | **[QA-A]** |
| Floor above ceiling | When break-even exceeds the maximum price, prices freeze and the screen says "raise the maximum price or enable clearance" | **[QA-A]** |
| Fee estimate expiry | A seller-declared fee estimate lives 90 days. A warning goes out 14 days before it ends; at expiry prices freeze with a critical alert. The alerts are raised by the scheduler | **[QA-B]** |
| Competitor coupons | Amazon reports a couponed price ($17.15 → $16.29). Both prices are stored and shown; strategies compete on the base price, so a one-day promotion cannot drag our prices down | **[QA-A]** |
| Segmented Buy Box | Amazon shows different winners to different buyer segments. The holder is whoever wins the majority of views. When nobody does, the console says "unknown", and a Buy Box strategy holds the price and names the reason | **[QA-A]** |
| Amazon Min/Max with known values | The marketplace's own Min/Max per SKU is shown next to our bounds. A price outside them is not sent ("no change" with both amounts), except a move toward them; clearance below Min warns before the checkbox | **[QA-A]** |
| Amazon Min/Max without values | The live adapter knows a SKU *has* seller-set limits but cannot read their values. In shadow, decisions are computed and marked "Price held: Amazon bounds". In live, enabling such an offer is refused, and the adapter refuses the write before sending | **[LIVE]** |
| No eligible competitors | When the chosen filter (say, FBA only) leaves nobody to compete with, the offer reports exactly that and holds its price — the filter is never silently betrayed | **[QA-A]** |
| Competitor seller links | A competitor's name links to their public storefront page — only when the marketplace supplied a real seller ID (Amazon SellerId). In the demo and simulator names stay plain text | **[LIVE]** |
| Coupon as a competitor price | A strategy option to compete on the couponed price | **[DEFERRED 109 (coupon)]** |

## 6. Bulk operations

**Imports — [QA-A].** Imports (Offers → Bulk operations, Costs & floors, Inventory) follow one pattern for every kind of data:
1. Download a template prefilled with your current data — not a blank form.
2. Edit the cells you need in Excel or any editor.
3. Upload. The server checks the file and shows exactly which rows will change and how, which are unchanged, and which are rejected and
   why (row, column, reason).
4. Apply exactly what was checked, all-or-nothing. A file with any error cannot be applied; data changed since the check is refused.
   No half-applied imports, ever.

Import kinds:
- unit costs and fees;
- min/max bounds and min margin;
- strategy assignments by name;
- stock;
- product details, including color.

Every import is journaled with who, when and the number of rows. Progress is visible while it runs. Applying 10,000 cost rows takes
3–11 s on CI runners.

**Bulk bounds edit — [QA-A].** Costs & floors → "Change bounds": choose offers (or the whole catalog), set or shift the minimum and/or
maximum price, preview the differences, apply.
- A minimum above the maximum is refused before anything runs, in one message that names the offers and both amounts; nothing is changed.
- Preview is off until you choose what to change; Apply is off when nothing would change. Both say why.
- The pick list names each offer with its color and channel ID, its bounds and its effective floor.
- A price outside the new bounds is stated as it is; for a shadow account the preview adds that new prices are only calculated, nothing is sent.
- Applying runs in the background; the bounds table and the pick list refresh by themselves when it is done, with one line
  "Successfully updated N offers".
- All-or-nothing, as imports; more than one offer needs a second factor.

**Exports — [QA-A].** Exports exist on every data screen, in CSV and XLSX, under one rule: what you see is what you export, with the
current filters and columns.
- Over 50,000 rows the export is refused honestly ("narrow the period").
- Column headers are always in English, whatever the UI language.
- Times are ISO with the time zone; money is a number plus a currency column.
- Files carry full channel names; chips are a screen-only convenience.
- Every export is an audit event.

## 7. Marketplace integrations

| Channel / function | Status (Nov 16, 2026) | Label |
|---|---|---|
| Amazon storefront in the demo (amazon.com, simulator) | Competitor drift, an undercutter, waves; competitive summaries; synthetic Min/Max on three products; a pressed shadow week | **[QA-A]** |
| Walmart storefront in the demo (walmart.com, simulator) | Buy Box strategy with step-up; two listings unpublished by the uncompetitive-price rule, shown as a pill and a journal event | **[QA-A]** |
| eBay storefront in the demo (ebay.com, simulator) | Target margin and scheduled recompute | **[QA-A]** |
| Channel simulator | A full synthetic marketplace used by the demo workspaces and by CI (chaos, demo-day and shadow-day runs). The static Amazon sandbox agreed with it as far as a static sandbox can show; live behavior is still to be proven on the first real account | **[QA-A]** |
| Client channels | A client workspace sees and connects amazon.com only; eBay and Walmart are not offered, named or warned about. The console takes this from `REPRACER_CLIENT_CHANNELS` (amazon_us by default in the US profile), the pilot database from its own setting (step 176, Р-256) | **[QA-B]** |
| Amazon connection flow | "Connect Amazon" on Channels → Amazon consent → the app's log-in URI → back to Amazon → our callback. The account is born in shadow and discovery starts by itself | **[QA-B]** |
| Amazon seller authorization and live calls | The developer profile is approved (public developer; roles: Product Listing, Pricing, Inventory and Order Tracking). The production app is registered (Draft). LWA accepts the credential pair (indirect evidence: a wrong secret is rejected as `invalid_client`); no production seller token yet. Sandbox recon: 32 calls against the static sandbox (20 OK, 9 expected 400s, 3 403s); the adapter parsed every returned shape | **[LIVE]** |
| Amazon price write and read-back | A price is written with `patchListingsItem` (asynchronous: accepted ≠ applied) and confirmed by reading it back; listing status and issues are read after every write | **[LIVE]** |
| eBay live adapter | OAuth and core calls proven in the official sandbox; old listings migrate only with the owner's consent. No production keys. Frozen: not in the first paid MVP (Р-251) | **[LIVE]** |
| Walmart live adapter | Built against a channel model from the owner's description of Walmart's rules; no spec snapshot and no keys yet. Frozen: not in the first paid MVP (Р-251) | **[LIVE]** |

Amazon specifics:

| Function | What it does | Label |
|---|---|---|
| Catalog discovery | The listings report (`GET_MERCHANT_LISTINGS_ALL_DATA`) — no 1,000-SKU cap; details by `searchListingsItems` in batches of 20. If the report is unavailable, search is the fallback and Channels says "may be incomplete". An unfinished discovery round resumes after 5, 10, 20, 40 minutes, then hourly. SKUs from the report that search did not return are named on Channels | **[LIVE]** |
| Competitor prices by polling | `getCompetitiveSummary`, up to 20 offers per window, one window every 31 s per seller-app pair; offers with a competitor-driven price go first. About 26 minutes per 1,000 such offers: a temporary exception from the 60 s reaction target until notifications work | **[LIVE]** |
| Listing status ("Not buyable on Amazon") | One observation from three sources (notification, read after write, discovery): a pill on Offers and a critical alert when an enabled offer becomes unbuyable. The demo does not produce it | **[LIVE]** |
| Notifications, part A | Listing events via EventBridge and offer/pricing events via SQS, both into one queue. Every notification lands raw in an append-only journal with deduplication. A dead receiver degrades honestly to polling and catches up when back. Chaos-tested: a crash at any of 28 points loses nothing and duplicates nothing | **[LIVE]** |
| Notifications, part B | Creating live destinations needs the grantless LWA scope `sellingpartnerapi::notifications`. It answers `invalid_scope` for both our apps, last re-checked on Nov 15, 2026 (5 of 5 attempts). Amazon closed case 23094609981, saying the request format is right and Draft status is not the cause; an evidence pack for a new case is ready. Until then everything runs on polling | **[LIVE]** |
| Amazon fees from the API | Fees come from the seller's file for now | **[DEFERRED 122 (П3)]** |
| Variations (parent/child) | Not modeled | **[DEFERRED 122 (П4)]** |
| Annual re-authorization | Amazon requires sellers to re-authorize yearly; no reminder yet | **[DEFERRED 122 (П8)]** |
| Authorization started from the Appstore | Only "Connect Amazon" from the console starts a connection; the Appstore flow appears after the app is published | **[DEFERRED 125 (П6)]** |
| Product color from marketplace attributes | Color is set by the seller's import for now | **[DEFERRED 112 (color)]** |

Real-world quirks already handled: competitor coupons, segmented Buy Box, `_CHANGE`/`_CHANGED` naming drift, `SellerId`/`SellerID` field
drift, an undocumented EventBridge envelope (an open question to Amazon), a response about another SKU than the one asked
(`RESPONSE_MISMATCH`, nothing written).

## 8. Audit and journals

**Journals — [QA-A].** Everything that happens is recorded, and nothing recorded can be changed. Journals are append-only at the database
level: price decisions, floor holds, stops (with the person's note), role changes, imports, exports (one audit event per export),
per-offer switches, default-strategy changes, clearance, notifications. Each entry carries who, what, when and why.

Retention is deliberate: decision explanations are kept forever; competitor details inside a decision for 30 days; competitor market
data at most 18 months (a marketplace-program requirement). Every journal screen exports like any other, so an accountant or an auditor
gets the same truth the screen shows.

## 9. Localization and market profiles

| Function | What it does | Label |
|---|---|---|
| English, Spanish, French | The console and all e-mails. A glossary test keeps terminology consistent across languages and fails the build if the brand is misspelled ("TM Price", "Tmprice") or an old name resurfaces. Amounts are in the storefront's currency; numbers and dates are US style; export headers stay English | **[QA-A]** |
| Market profile `us` | amazon.com, walmart.com, ebay.com. The deployment setting hides EU storefronts, Kaufland, German and Omnibus without deleting anything | **[QA-A]** |
| EU profile | European storefronts, Kaufland, German and Omnibus — built, frozen | **[DEFERRED 135 (EU)]** |

## 10. Reliability and quality engineering

The product moves money, so the pipeline is built to distrust itself:
- **Red first.** Every change starts with a failing test that proves the problem exists; only then comes the fix. Exceptions must be
  named explicitly and carry proof.
- **Mutation catalog.** Every database protection is removed one at a time, and each removal must be caught by its own check. Last
  nightly run (Nov 15, 2026): 888 mutations, 888 caught.
- **Chaos tests.** Processes are killed at every batch boundary mid-work. Invariants (no lost stock recalculation, exactly-once
  notification handling) must survive every crash point.
- **Scale guard.** The full catalog state for 50,000 offers must compute within a hard time budget on every run. It is measured at
  7–10 s, and the limit is temporarily 15 s with a return ticket back to 10 s. Performance regressions fail CI; they don't reach sellers.
- **Two CI lanes.**
  - Fast checks run on every commit, including a scripted walk through the whole console.
  - The heavy lane adds the full suite, mutations, chaos, scale, a simulated demo day and a shadow day.
  - Nothing merges to main except green code through a fast-forward-only gate. GitHub branch protection enforces it even against
    administrators.
- **Nightly runs with a watchman.** Every night the full suite runs on main. A red night opens an issue and blocks merges, and the first
  green run closes it.
- **Honest performance numbers.** Time limits are set against the slowest CI runners, with documented return tickets when a limit is
  temporarily raised.

## 11. Security

| Function | What it does | Label |
|---|---|---|
| Tenant isolation | PostgreSQL row-level security: every query runs inside one workspace's row set; cross-tenant reads are impossible at the database layer. On QA-A one login holds three workspaces, so cross-workspace checks are possible | **[QA-A]** |
| QA cannot write to channels | A database setting on QA (and on the pilot until lifted by a two-person procedure) refuses live mode and every outgoing write; the demo workspace is the only exception | **[QA-A]** |
| Secrets | Marketplace keys and tokens live outside the repository in permission-restricted files, are never printed to logs, chats or reports, and are passed between people only by secure means. Channel tokens are stored encrypted (AES-256-GCM); only the adapters' role can read them | **[QA-B]** |
| Least privilege | Marketplace app roles are exactly the approved ones (Product Listing, Pricing, Inventory and Order Tracking). Each process connects to the database with its own narrow role. The operator panel is a separate, non-public process | **[QA-B]** |
| Second factor | Guards every action that moves the price fence (§ 2) | **[QA-B]** |
| Transport and storage | TLS in transit (Cloudflare tunnel); all administrative actions and data changes journaled | **[QA-B]** |
| Read-access auditing | Not implemented. The public privacy policy is being corrected to say exactly what is true before the site goes live | **[DEFERRED 135 (read audit)]** |

## 12. Pilot onboarding and operations

A new client never flips a switch they haven't watched.

| Function | What it does | Label |
|---|---|---|
| Operator creates a workspace and invites the owner | Operator panel (SSH tunnel only, second factor on every action). Without a mail provider the invitation link is shown to the operator once, behind a flag, as an audit event | **[QA-B]** |
| Guided onboarding | Two paths: stock only, or stock + repricing. Each step turns complete from the data, not from a checkbox; cost cannot be skipped, the set can be narrowed | **[QA-B]** |
| Scheduler | Discovery, competitor polling, scheduled recompute, ladders, fee-expiry warnings, alert delivery, retention — as a separate process with a lease in the database | **[QA-B]** |
| Shadow week on the seller's real catalog | The client's account connects; the engine runs fully — snapshots, strategies, gates, journals — but sends nothing. The seller reviews every decision on their own catalog | **[LIVE]** |
| Day boundary acceptance | Before going live on amazon.com the operator accepts the storefront's day boundary by the worst window after a 7-day shadow run; the database computes the evidence | **[LIVE]** |
| Go live | Owner or Manager + second factor + typed account name, after the live-write guard is lifted by procedure. Every fence rule applies from the first second | **[LIVE]** |
| Go-live refusal for offers with unreadable Amazon limits | Going live is refused while enabled offers have Amazon Min/Max without read values, and the refusal names them (SKU · storefront, the first 20 and how many more) with what to do: remove the limits in Seller Central or turn repricing off (Offers → Turn off). Nothing is changed silently. Built in step 136; on QA-A and QA-B the live-write guard refuses first, so it shows on the first real live switch | **[LIVE]** |
| Stay in control | One button stops a channel account, a storefront or the whole workspace instantly, with a note on the permanent record; a single offer is paused by turning its pricing off | **[QA-A]** |
| Database copies | Daily encrypted copy (owner's public key), pulled to the operator's machine with SHA-256 checks; a restore check at least every 7 days; no deploy without them | **[QA-B]** |
| External monitoring | Heartbeats from every process, after every copy, log archive and pull (healthchecks.io, e-mail on silence); an external `/healthz` monitor for the pilot. The QA-B `/healthz` is behind Access and has no external monitor (owner decision) | **[QA-B]** |
| Logs for 12 months | Container logs archived daily (hot 30–61 days, monthly archives 13 months) and pulled off the server — an Amazon data-protection requirement | **[QA-B]** |
| Rollback | The migration plan is checked before switching code. Releases with migrations take a copy first. A rollback restores that copy in place | **[QA-B]** |
| QA-B reset | Rebuilds only a database marked `qa-b`; the pilot database refuses | **[QA-B]** |
| Alert e-mails | Alerts and digests are built but not sent until a mail provider is chosen (`DRY_RUN`); the operator panel shows them | **[DEFERRED 135 (mail)]** |

A step-by-step first-live-account checklist exists in the repository
([docs/live-first-account-checklist.md](live-first-account-checklist.md)): what to verify on a real account, with which call, and what
counts as success. Sales demos run on a dedicated demo workspace with synthetic data and a clearly marked banner.

## 13. Known limitations and the road to the first client

Open items on the critical path:

| Item | Owner | State (Nov 16, 2026) |
|---|---|---|
| Amazon grantless scope for notifications (`invalid_scope`) | Amazon support + Merdan (AWS access) | Case 23094609981 closed by Amazon; evidence pack for a new case ready (Nov 15) |
| QA-B machine | Merdan approves the purchase | Code and runbook ready. Machine: 4 vCPU / 8 GB / 80 GB SSD. The kit has a ClickHouse memory ceiling and your SSH gate (`logs`, `reset`, `version`), as on QA-A |
| Pilot server | At launch | Code and runbook ready. The write path (Redpanda broker and pricing worker) is in the kit and is switched on on the go-live day, together with the removal of the live-writes guard |
| Seller account for QA-B (Amazon, Individual) | Owner with Merdan | Open |
| Mail provider | Owner and Merdan | Resend chosen. CRITICAL alerts go to both of us through one shared `ops@tmprice.com` address (Cloudflare Email Routing); no code change. Not connected until you approve |
| Publish tmprice.com + support@ mailbox; client CSV request letter; pilot paperwork | Kerim | As of Nov 6; not tracked in the repository |

Deliberately out of scope for the pilot (manual or deferred, none block a client):
- in-product billing (invoices go out by hand);
- reading product color from marketplace attributes;
- a competitor-profile page inside the product **[DEFERRED 107 (competitor profile)]**;
- returning the 50,000-offer time budget from its temporary ceiling to the target, held by an automatic return ticket
  **[DEFERRED 107/110.3 (scale)]**.

Honest constraints today:
- Sellers only, no Vendors.
- US marketplaces first; the EU is built but frozen.
- Competitor-following strategies on live Amazon run on polling: a reaction takes up to about 26 minutes per 1,000 competitive offers,
  not 60 s.
- Amazon Min/Max values are not read live: in live mode such offers cannot be enabled, and going live is refused while they are enabled.

## 14. Glossary

| Term | Meaning in the console |
|---|---|
| Workspace | One seller business: its channels, team, journals |
| Channel account | One connection to one marketplace, in shadow or live mode |
| Storefront | A marketplace site (amazon.com, walmart.com); sets the currency |
| Offer | One product on one storefront |
| Buy Box | The marketplace's default "Add to cart" winner for a product |
| FBA / FBM | Fulfilled by Amazon / by the merchant — a strategy can compete with either group or both |
| Strategy | A versioned pricing rule in plain words, assigned to offers |
| Anchor | What the strategy prices against: Buy Box, lowest price, or the lower of the two |
| Break-even | Unit cost + marketplace fees; always part of the floor outside clearance |
| Effective floor | The highest applicable floor — the price the system will not go below |
| Clearance | Deliberate below-cost selling, signed and journaled, per offer |
| Shadow mode | Engine computes everything, sends nothing |
| Decision record | The permanent receipt of one price decision (seven stations) |
| Price statuses | One vocabulary on Protections, Price changes and the receipt: **Adjusted to limit** (the strategy target was set to a bound), **Rejected** (the Price Gate refused, the price stayed; dangerous when over 10% beyond a bound), **Blocked** (a pause: a person's stop, an inactive offer, step and frequency limits, a write stopped at sending, a rejected snapshot), **Held in shadow mode** (approved, nothing sent), **Approved for sending** (approved on a live account), **No change** |
| Price gate | The 13 final checks between a proposal and the store |
| Floor hold | A moment the floor overrode the strategy — counted and valued on Protections |
| Journal | An append-only log; nothing in it can be rewritten by anyone |

## 15. Deferred references

The rows of [docs/deferred.md](deferred.md) behind each **[DEFERRED]** label (row names there are in Russian):

| Label | Row in docs/deferred.md |
|---|---|
| 135 (guest) | «135 (гость демо)» |
| 135 (billing) | «135 (биллинг)» |
| 135 (EU) | «135 (профиль ЕС)» |
| 135 (read audit) | «135 (аудит чтения)» |
| 135 (mail) | «135 (почтовый провайдер)» |
| 109 (coupon) | «109 (купон как цена конкурента, Р-234)» |
| 112 (color) | «112 (цвет товара из каналов, Р-238)» |
| 107 (competitor profile) | «107 (профиль конкурента)» |
| 107/110.3 (scale) | «107 (замер масштаба, OQ-248), 110.3» |
| 122 (П3) | «122 (П3, комиссия Amazon через API)» |
| 122 (П4) | «122 (П4, вариации Amazon)» |
| 122 (П8) | «122 (П8, ежегодная переавторизация Amazon)» |
| 125 (П6) | «125 (П6, авторизация из Appstore)» |
