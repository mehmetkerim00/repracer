import { createHash } from 'node:crypto';
import type { AdapterCallContext, ChannelError, ListingPreflight, MigrationConsentProof, MigrationOutcome } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { BULK_MIGRATE_MAX, BULK_MIGRATE_PATH, EBAY_MARKETPLACES, INVENTORY_PATH, marketplaceInfo } from './descriptor.ts';
import { channelError, classifyHttpFailure, describeRestError, type EbayRestError, firstRestError } from './errors.ts';
import { LISTING_ID_RE } from './mapping.ts';
import type { EbayOffer } from './readback.ts';
import { call, nowMs, openSession, type ResolvedOptions, type Session } from './session.ts';

/**
 * Предполётная проверка и миграция листингов eBay [Р-2, Р-164; docs/onboarding-ebay-migration.md]. Миграция необратима: единственный
 * путь — migrate(proofs) с доказательством согласия владельца (MigrationConsentProof создаёт ядро после MIGRATION_STARTED в базе, 0010);
 * без него метод не вызвать по типу. Автомиграции нет нигде: запись в немигрированный листинг отклоняется (planning.ts), а не мигрирует его.
 *
 * Чтение — Trading API GetItem и GetUserPreferences токеном OAuth (X-EBAY-API-IAF-TOKEN) и Inventory `offer?sku=` [песочница]. Из ответа
 * берётся только то, что нужно проверкам: ни адрес, ни почта продавца (в GetItem они есть) не попадают ни в находки, ни в журнал (Р-4).
 */

const XMLNS = 'urn:ebay:apis:eBLBaseComponents';

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]! : null;
}
function has(xml: string, name: string): boolean {
  return new RegExp(`<${name}[\\s>/]`).test(xml);
}
function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]!);
}

export function getItemRequest(listingId: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="${XMLNS}"><ItemID>${listingId}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`;
}
export const GET_USER_PREFERENCES_REQUEST = `<?xml version="1.0" encoding="utf-8"?><GetUserPreferencesRequest xmlns="${XMLNS}"><ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference></GetUserPreferencesRequest>`;

/** Подмножество GetItem, по которому выносится вердикт; его SHA-256 — listingSnapshotSha256 согласия */
export interface ListingFacts {
  itemId: string;
  listingType: string | null;
  sku: string | null;
  variationSkus: string[] | null;
  bestOfferEnabled: boolean;
  charity: boolean;
  buyerRequirements: boolean;
  sellerProfiles: boolean;
  themeId: string | null;
  layoutId: string | null;
  outOfStockControl: boolean | null;
  /** Сайт и валюта листинга (`Site`, `Currency` в GetItem [песочница]). В отпечаток согласия не входят: у листинга они не меняются */
  site?: string | null;
  currency?: string | null;
}

export function parseGetItem(xml: string): { ok: true; facts: Omit<ListingFacts, 'outOfStockControl'> } | { ok: false; error: string } {
  const ack = tag(xml, 'Ack');
  const item = tag(xml, 'Item');
  if ((ack !== 'Success' && ack !== 'Warning') || item === null) {
    return { ok: false, error: `${tag(xml, 'ErrorCode') ?? '?'}: ${(tag(xml, 'ShortMessage') ?? `Ack ${ack ?? 'missing'}`).slice(0, 200)}` };
  }
  const variations = tag(item, 'Variations');
  const own = variations === null ? item : item.replace(/<Variations>[\s\S]*<\/Variations>/, '');
  const itemId = tag(own, 'ItemID') ?? '';
  const bestOffer = tag(own, 'BestOfferDetails');
  const profiles = tag(own, 'SellerProfiles');
  return {
    ok: true,
    facts: {
      itemId, listingType: tag(own, 'ListingType'), sku: tag(own, 'SKU'),
      variationSkus: variations === null ? null : blocks(variations, 'Variation').map((v) => tag(v, 'SKU') ?? ''),
      bestOfferEnabled: bestOffer !== null && tag(bestOffer, 'BestOfferEnabled') === 'true',
      charity: has(own, 'Charity') || has(own, 'CharityID'),
      buyerRequirements: has(own, 'BuyerRequirementDetails'),
      sellerProfiles: profiles !== null && /<\w+ProfileID>\d+<\/\w+ProfileID>/.test(profiles),
      themeId: tag(own, 'ThemeID'), layoutId: tag(own, 'LayoutID'), site: tag(own, 'Site'), currency: tag(own, 'Currency'),
    },
  };
}

export function snapshotSha256(facts: ListingFacts): string {
  const canonical = JSON.stringify([
    facts.itemId, facts.listingType, facts.sku, facts.variationSkus, facts.bestOfferEnabled, facts.charity, facts.buyerRequirements,
    facts.sellerProfiles, facts.themeId, facts.layoutId, facts.outOfStockControl,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

interface Preflighted extends ListingPreflight { offerIds: string[] }

function siteIdOf(session: Session): number {
  const first = session.account.marketplaces.find((m) => marketplaceInfo(m));
  return first ? EBAY_MARKETPLACES[first as keyof typeof EBAY_MARKETPLACES].tradingSiteId : EBAY_MARKETPLACES.EBAY_DE.tradingSiteId;
}

async function trading(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, callName: string, xml: string): Promise<{ ok: true; xml: string } | { ok: false; error: string }> {
  const r = await call(options, ctx, session, { auth: 'USER', method: 'POST', path: '', body: xml, trading: { callName, siteId: siteIdOf(session) }, idempotent: true, operation: callName });
  if (r.kind === 'REFUSED') return { ok: false, error: `${r.error.code}: ${r.error.message}` };
  if (!r.result.ok || typeof r.result.body !== 'string') return { ok: false, error: `HTTP ${String(r.result.status)}` };
  return { ok: true, xml: r.result.body };
}

/** C02: листинг уже под Inventory API — у SKU есть предложение этого листинга; 404 25713 — нет [песочница] */
async function managedOffers(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, sku: string, listingId: string): Promise<{ ok: true; offerIds: string[] } | { ok: false; error: string }> {
  const r = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/offer`, query: { sku }, operation: 'getOffers' });
  if (r.kind === 'REFUSED') return { ok: false, error: `${r.error.code}: ${r.error.message}` };
  if (r.result.status === 404 && firstRestError(r.result.body)?.errorId === 25713) return { ok: true, offerIds: [] };
  if (!r.result.ok) return { ok: false, error: describeRestError(firstRestError(r.result.body), `HTTP ${String(r.result.status)}`) };
  const offers = ((r.result.body ?? {}) as { offers?: EbayOffer[] }).offers ?? [];
  return { ok: true, offerIds: offers.filter((o) => o.listing?.listingId === listingId && typeof o.offerId === 'string').map((o) => o.offerId!) };
}

async function preflightAll(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, listingIds: readonly string[]): Promise<Preflighted[]> {
  const prefs = await trading(options, ctx, session, 'GetUserPreferences', GET_USER_PREFERENCES_REQUEST);
  const oosText = prefs.ok ? tag(prefs.xml, 'OutOfStockControlPreference') : null;
  const outOfStockControl = oosText === 'true' ? true : oosText === 'false' ? false : null;
  const out: Preflighted[] = [];
  for (const listingId of listingIds) {
    const unknown = (details: string): Preflighted => ({
      listingId, listingSnapshotSha256: createHash('sha256').update(`unknown:${listingId}`).digest('hex'), verdict: 'UNKNOWN', offerIds: [],
      findings: [{ code: 'PREFLIGHT_INCOMPLETE', severity: 'BLOCKER', details }],
    });
    if (!LISTING_ID_RE.test(listingId)) { out.push(unknown('listing id is not an eBay ItemID')); continue; }
    const read = await trading(options, ctx, session, 'GetItem', getItemRequest(listingId));
    const parsed = read.ok ? parseGetItem(read.xml) : null;
    if (!read.ok || !parsed || !parsed.ok) { out.push(unknown(`GetItem failed: ${read.ok ? (parsed && !parsed.ok ? parsed.error : '?') : read.error}`)); continue; }
    const facts: ListingFacts = { ...parsed.facts, outOfStockControl };
    if (facts.itemId !== listingId) { out.push(unknown('GetItem answered for another listing')); continue; }
    const findings: ListingPreflight['findings'] = [];
    const auction = facts.listingType === 'Chinese';
    if (auction) findings.push({ code: 'C01_AUCTION', severity: 'BLOCKER', details: 'auction listing (ListingType Chinese): auctions are never migrated or managed (Р-2)' });
    /**
     * Шаг 48 (E-19, находка 3 ревью): обнаружение относит старый листинг к витрине аккаунта только по ВАЛЮТЕ — GetMyeBaySelling
     * отдаёт листинги всего аккаунта, и евровый листинг ebay.at попал бы в каталог как EBAY_DE. Миграция — единственное действие
     * с таким листингом, и перед ней витрина сверяется по сайту GetItem: чужой сайт — препятствие, неопознанный — предупреждение.
     */
    // Сверяется витрина, к которой обнаружение отнесло листинг, — витрина аккаунта с валютой листинга (EBAY_C16)
    const placedOn = session.account.marketplaces.filter((m) => { const i = marketplaceInfo(m); return i !== null && (!facts.currency || i.currency === facts.currency); });
    const siteNames = placedOn.map((m) => marketplaceInfo(m)?.tradingSiteName ?? null);
    if (!facts.site || !siteNames.includes(facts.site)) {
      if (facts.site && siteNames.length > 0 && siteNames.every((n) => n !== null)) {
        findings.push({ code: 'C13_SITE', severity: 'BLOCKER', details: `the listing is on eBay site ${facts.site}, not on a storefront of this account; discovery placed it by currency (E-19)` });
      } else {
        logConservative(options.deps.logger, ctx, 'EBAY_C16_TRADING_LISTING_SITE', { listingId, site: facts.site ?? null, confirmed: false });
        findings.push({ code: 'C13_SITE_UNCONFIRMED', severity: 'WARNING', details: `the eBay site of the listing (${facts.site ?? 'not named'}) cannot be matched to a storefront of this account (E-19)` });
      }
    }
    const skus = [facts.sku, ...(facts.variationSkus ?? [])].filter((s): s is string => Boolean(s));
    const missingSku = !facts.sku && (facts.variationSkus === null || facts.variationSkus.some((s) => !s));
    const duplicateSku = facts.variationSkus !== null && new Set(facts.variationSkus).size !== facts.variationSkus.length;
    if (missingSku || duplicateSku) findings.push({ code: 'C07_SKU', severity: 'BLOCKER', details: missingSku ? 'the listing or a variation has no SKU: set SKUs on eBay' : 'variation SKUs repeat: make them unique on eBay' });
    if (!facts.sellerProfiles) findings.push({ code: 'C08_BUSINESS_POLICIES', severity: 'BLOCKER', details: 'the listing uses no business policies (payment, shipping, return): assign them on eBay' });
    if (facts.bestOfferEnabled) {
      logConservative(options.deps.logger, ctx, 'EBAY_C10_BEST_OFFER_LOSS', { listingId });
      findings.push({ code: 'C03_BEST_OFFER', severity: 'LOSS', details: 'Best Offer is enabled: after migration its settings can no longer be managed (Р-2; the sandbox kept it — not proven for production, E-15)' });
    }
    if (facts.buyerRequirements) findings.push({ code: 'C04_BUYER_REQUIREMENTS', severity: 'LOSS', details: 'buyer requirements are set: they are lost after migration (Р-2)' });
    if (facts.charity) findings.push({ code: 'C05_CHARITY', severity: 'LOSS', details: 'the listing supports a charity: lost after migration (Р-2)' });
    logConservative(options.deps.logger, ctx, 'EBAY_C11_TEMPLATE_UNDETECTABLE', { listingId, themeId: facts.themeId, layoutId: facts.layoutId });
    findings.push({ code: 'C06_TEMPLATE', severity: 'INFO', details: 'whether a design template is used cannot be determined: ThemeID/LayoutID are set on every listing by default (E-14)' });
    logConservative(options.deps.logger, ctx, 'EBAY_C12_OTHER_TOOLS_ALWAYS_WARN', { listingId });
    findings.push({ code: 'C10_OTHER_TOOLS', severity: 'WARNING', details: 'other programs editing this listing through the Trading API must be declared by the seller; their edits diverge from the Inventory API offer (E-16)' });
    if (outOfStockControl === false) findings.push({ code: 'C11_OUT_OF_STOCK_CONTROL', severity: 'WARNING', details: 'out-of-stock control is off: quantity 0 may end the listing (E-06); turn it on before migration' });
    if (facts.variationSkus !== null) {
      // Browse v1|<ItemID>|0 адресует листинг, а не вариацию: цену вариации по живому листингу не подтвердить [EBAY_C15]
      logConservative(options.deps.logger, ctx, 'EBAY_C15_VARIATIONS_PRICE_CONFIRMATION', { listingId, variations: facts.variationSkus.length });
      findings.push({ code: 'C12_VARIATIONS', severity: 'WARNING', details: `multi-variation listing (${facts.variationSkus.length}): the 250 daily edits are shared by all variations (E-02), and the price of a variation cannot be confirmed on the live listing (E-13)` });
    }

    let offerIds: string[] = [];
    let managedUnknown: string | null = null;
    if (skus.length > 0 && !auction) {
      const managed = await managedOffers(options, ctx, session, skus[0]!, listingId);
      if (managed.ok) offerIds = managed.offerIds;
      else managedUnknown = managed.error;
    }
    const sha = snapshotSha256(facts);
    const blockers = findings.filter((f) => f.severity === 'BLOCKER');
    let verdict: ListingPreflight['verdict'];
    // Листинг чужого сайта eBay этому аккаунту не принадлежит: исправить это продавец не может — не FIXABLE, а INELIGIBLE (шаг 48)
    if (auction || findings.some((f) => f.code === 'C13_SITE')) verdict = 'INELIGIBLE';
    else if (managedUnknown !== null || outOfStockControl === null) {
      findings.push({ code: 'PREFLIGHT_INCOMPLETE', severity: 'BLOCKER', details: managedUnknown ?? 'out-of-stock control preference was not read' });
      verdict = 'UNKNOWN';
    } else if (offerIds.length > 0) verdict = 'ALREADY_MANAGED';
    else if (blockers.length > 0) verdict = 'FIXABLE';
    else if (findings.some((f) => f.severity === 'LOSS')) verdict = 'READY_WITH_LOSSES';
    else verdict = 'READY';
    if (offerIds.length > 0) findings.push({ code: 'C02_ALREADY_MANAGED', severity: 'INFO', details: 'the listing is already under Inventory API: no migration needed' });
    out.push({ listingId, listingSnapshotSha256: sha, verdict, findings, offerIds });
  }
  return out;
}

export async function preflightEbay(options: ResolvedOptions, ctx: AdapterCallContext, listingIds: readonly string[]): Promise<ListingPreflight[]> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) {
    return listingIds.map((listingId) => ({ listingId, listingSnapshotSha256: createHash('sha256').update(`unknown:${listingId}`).digest('hex'), verdict: 'UNKNOWN' as const,
      findings: [{ code: 'PREFLIGHT_INCOMPLETE', severity: 'BLOCKER' as const, details: `${opened.error.code}: ${opened.error.message}` }] }));
  }
  return (await preflightAll(options, ctx, opened.session, listingIds)).map(({ offerIds: _o, ...p }) => p);
}

interface MigrateResponse { statusCode?: number; listingId?: string; inventoryItems?: Array<{ sku?: string; offerId?: string }>; errors?: EbayRestError[] }

/**
 * Миграция [Р-164]: 1–5 листингов за вызов (Р-2; песочница проверила 1). Перед вызовом каждый листинг проверяется ЗАНОВО, и снимок
 * должен совпасть с тем, на который дано согласие: изменился — согласие недействительно (принцип 4 онбординга). Уже под Inventory API
 * (прошлая попытка с неизвестным итогом всё же прошла) — MIGRATED с найденными предложениями, без второго вызова.
 * Обрыв, тайм-аут и 5xx — OUTCOME_UNKNOWN без повтора [EBAY_C02]: следующая попытка начнётся с той же перепроверки.
 */
export async function migrateEbay(options: ResolvedOptions, ctx: AdapterCallContext, proofs: readonly MigrationConsentProof[]): Promise<MigrationOutcome[]> {
  if (proofs.length === 0) return [];
  const failAll = (error: ChannelError) => proofs.map((p) => ({ listingId: p.listingId, status: 'FAILED' as const, error }));
  if (proofs.length > BULK_MIGRATE_MAX) return failAll(channelError('VALIDATION', 'BATCH', `bulk_migrate_listing takes 1 to ${BULK_MIGRATE_MAX} listings per call (Р-2)`));
  const opened = await openSession(options, ctx);
  if (!opened.ok) return failAll(opened.error);
  const { session } = opened;
  // Итог — по номеру доказательства в вызове: ключ «листинг» или «листинг#согласие» мог совпасть у двух доказательств
  const outcomes: Array<MigrationOutcome | undefined> = proofs.map(() => undefined);
  const seen = new Set<string>();
  const candidates: Array<{ p: MigrationConsentProof; i: number }> = [];
  proofs.forEach((p, i) => {
    if (p.offerMappingStatus !== 'MIGRATION_STARTED' || !p.migrationConsentId || !LISTING_ID_RE.test(p.listingId) || seen.has(p.listingId)) {
      outcomes[i] = { listingId: p.listingId, status: 'FAILED',
        error: channelError('PRECONDITION_FAILED', 'ITEM', 'migration needs one consent proof per listing in MIGRATION_STARTED (Р-2, Р-164)') };
      return;
    }
    seen.add(p.listingId);
    candidates.push({ p, i });
  });
  const checked = await preflightAll(options, ctx, session, candidates.map(({ p }) => p.listingId));
  const send: Array<{ p: MigrationConsentProof; i: number }> = [];
  for (const { p, i } of candidates) {
    const pf = checked.find((c) => c.listingId === p.listingId)!;
    if (pf.verdict === 'ALREADY_MANAGED') { outcomes[i] = { listingId: p.listingId, status: 'MIGRATED', externalOfferIds: pf.offerIds }; continue; }
    if (pf.verdict === 'UNKNOWN') {
      // Перепроверка не завершилась (сбой чтения, бюджет запросов): это не «листинг изменился», повтор позже
      const why = pf.findings.find((f) => f.code === 'PREFLIGHT_INCOMPLETE')?.details ?? 'preflight incomplete';
      outcomes[i] = { listingId: p.listingId, status: 'FAILED', error: channelError('CHANNEL_UNAVAILABLE', 'ITEM', `the listing could not be re-checked before migration: ${why}`) };
      continue;
    }
    if (pf.listingSnapshotSha256 !== p.listingSnapshotSha256) {
      outcomes[i] = { listingId: p.listingId, status: 'FAILED', error: channelError('PRECONDITION_FAILED', 'ITEM', 'the listing changed since the owner consented: a new preflight and consent are needed') };
      continue;
    }
    if (pf.verdict !== 'READY' && pf.verdict !== 'READY_WITH_LOSSES') {
      outcomes[i] = { listingId: p.listingId, status: 'FAILED', error: channelError('PRECONDITION_FAILED', 'ITEM', `preflight verdict is ${pf.verdict}: the listing is not migrated`) };
      continue;
    }
    send.push({ p, i });
  }
  if (send.length > 0) {
    options.deps.logger.log({
      level: 'INFO', code: 'EBAY_LISTING_MIGRATION', message: 'irreversible bulk_migrate_listing with owner consent (Р-2, Р-164)',
      correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
      details: { listings: send.length, consents: send.map(({ p }) => p.migrationConsentId).join(',') },
    });
    const r = await call(options, ctx, session, { auth: 'USER', method: 'POST', path: BULK_MIGRATE_PATH, body: { requests: send.map(({ p }) => ({ listingId: p.listingId })) }, idempotent: false, operation: 'bulkMigrateListing' });
    if (r.kind === 'REFUSED') {
      for (const { p, i } of send) outcomes[i] = { listingId: p.listingId, status: 'FAILED', error: r.error };
    } else {
      const responses = (r.result.body as { responses?: MigrateResponse[] } | undefined)?.responses;
      if (typeof r.result.status === 'number' && r.result.status < 500 && Array.isArray(responses)) {
        for (const { p, i } of send) {
          const x = responses.find((y) => y?.listingId === p.listingId);
          if (x?.statusCode === 200) {
            outcomes[i] = { listingId: p.listingId, status: 'MIGRATED', externalOfferIds: (x.inventoryItems ?? []).map((item) => item.offerId).filter((o): o is string => typeof o === 'string') };
          } else if (!x) {
            outcomes[i] = { listingId: p.listingId, status: 'OUTCOME_UNKNOWN', error: channelError('UNKNOWN', 'ITEM', 'bulk_migrate_listing answered without this listing', { raiseAlert: true }) };
          } else {
            const e = x.errors?.[0] ?? null;
            outcomes[i] = { listingId: p.listingId, status: 'FAILED', error: channelError('VALIDATION', 'ITEM', describeRestError(e, `item status ${x.statusCode ?? '?'}`),
              { ...(e?.errorId !== undefined ? { channelCode: String(e.errorId) } : {}), ...(x.statusCode !== undefined ? { httpStatus: x.statusCode } : {}) }) };
          }
        }
      } else {
        const error = classifyHttpFailure(r.result.status, r.result.body, 'BATCH', nowMs(options));
        if (r.result.outcomeUnknown) logConservative(options.deps.logger, ctx, 'EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES', { operation: 'bulkMigrateListing', status: String(r.result.status) });
        for (const { p, i } of send) outcomes[i] = r.result.outcomeUnknown ? { listingId: p.listingId, status: 'OUTCOME_UNKNOWN', error } : { listingId: p.listingId, status: 'FAILED', error };
      }
    }
  }
  return outcomes.map((o) => o!);
}
