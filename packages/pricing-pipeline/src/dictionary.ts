import { SANITY_RULESET } from '@repracer/input-sanity';
import { GATE_PROFILE, GATE_PROFILE_G74 } from '@repracer/price-gate';
import type { ExplanationRuleset } from '@repracer/pricing-model';

/**
 * Справочники слепка объяснения [Р-75], которые знает код: набор правил проверки входов и профиль Gate.
 * В PostgreSQL те же строки — `platform.explanation_ruleset` (0044); совпадение проверяет тест.
 */
export const EXPLANATION_RULESETS: readonly ExplanationRuleset[] = [SANITY_RULESET, GATE_PROFILE_G74, GATE_PROFILE];
