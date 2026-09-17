import type { Scenario } from '../harness/scenario.ts';
import { buildAdapterScenarios } from './adapter-scenarios.ts';
import { buildCoreScenarios } from './core-scenarios.ts';
import { buildPipelineScenarios } from './scenarios.ts';

export function buildAmazonScenarios(): Array<{ file: string; scenario: Scenario }> {
  return [...buildAdapterScenarios(), ...buildPipelineScenarios(), ...buildCoreScenarios()].sort((a, b) => a.file.localeCompare(b.file));
}

export const AMAZON_FIXTURES_DIR = new URL('../../fixtures/amazon/', import.meta.url);
