import type { ScenarioRecord, YunoMockRepository, YunoMockStore } from '../persistence/types.js';
import {
  DEFAULT_PAYMENT_SCENARIO,
  PAYMENT_SCENARIO_CONTROL_ID,
  type PaymentScenario,
  isPaymentScenario,
} from '../domain/scenarios.js';
import { Errors } from '../errors.js';
import { nowIso } from '../domain/ids.js';

function findPaymentScenarioRecord(store: YunoMockStore): ScenarioRecord | undefined {
  return store.scenarios.find((s) => s.id === PAYMENT_SCENARIO_CONTROL_ID);
}

export function readPaymentScenario(store: YunoMockStore): PaymentScenario {
  const record = findPaymentScenarioRecord(store);
  const name = record?.name ?? record?.data?.scenario;
  if (isPaymentScenario(name)) return name;
  return DEFAULT_PAYMENT_SCENARIO;
}

export async function getPaymentScenario(
  repo: YunoMockRepository,
): Promise<{ scenario: PaymentScenario }> {
  return repo.withLock((store) => ({ scenario: readPaymentScenario(store) }));
}

export async function setPaymentScenario(
  repo: YunoMockRepository,
  scenario: PaymentScenario,
): Promise<{ scenario: PaymentScenario }> {
  if (!isPaymentScenario(scenario)) {
    throw Errors.invalidRequest(`unknown payment scenario: ${String(scenario)}`);
  }
  return repo.withLock((store) => {
    const ts = nowIso();
    const existing = findPaymentScenarioRecord(store);
    if (existing) {
      existing.name = scenario;
      existing.data = { scenario };
      // ScenarioRecord has no updatedAt — createdAt remains first-set.
      void ts;
    } else {
      store.scenarios.push({
        id: PAYMENT_SCENARIO_CONTROL_ID,
        name: scenario,
        data: { scenario },
        createdAt: ts,
      });
    }
    return { scenario };
  });
}

export async function resetPaymentScenario(
  repo: YunoMockRepository,
): Promise<{ scenario: PaymentScenario }> {
  return repo.withLock((store) => {
    const idx = store.scenarios.findIndex((s) => s.id === PAYMENT_SCENARIO_CONTROL_ID);
    if (idx >= 0) store.scenarios.splice(idx, 1);
    return { scenario: DEFAULT_PAYMENT_SCENARIO };
  });
}
