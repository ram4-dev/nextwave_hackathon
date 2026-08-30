import type { AppConfig } from '../config/env.js';
import { DemoKycAdapter } from './demo.js';
import { DiditKycAdapter } from './didit.js';
import { IncodeKycAdapter } from './incode.js';
import { VeriffKycAdapter } from './veriff.js';
import type { KycAdapter } from './types.js';

export function createKycAdapters(config: AppConfig): {
  primary: KycAdapter;
  byName: Record<string, KycAdapter>;
} {
  const didit = new DiditKycAdapter(config);
  const incode = new IncodeKycAdapter(config);
  const veriff = new VeriffKycAdapter(config);

  const byName: Record<string, KycAdapter> = {
    didit,
    incode,
    veriff,
  };

  // Demo adapter is forbidden in live mode (no provider=demo, no demo webhooks).
  if (config.KYA_MODE === 'demo') {
    byName.demo = new DemoKycAdapter();
  }

  const primary = config.KYA_MODE === 'demo' ? byName.demo! : didit;

  return { primary, byName };
}

export * from './types.js';
export * from './demo.js';
export * from './didit.js';
export * from './incode.js';
export * from './veriff.js';
