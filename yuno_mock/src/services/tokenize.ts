import { createHmac, randomUUID } from 'node:crypto';

export type Brand = 'VISA' | 'MASTERCARD' | 'AMEX' | 'UNKNOWN';

export type TokenizeInput = {
  pan: string;
  cvv: string;
  expirationMonth: number;
  expirationYear: number;
  fingerprintSecret: string;
};

export type TokenizedCard = {
  vaulted_token: string;
  fingerprint: string;
  brand: Brand;
  last4: string;
  iin: string;
  expiration_month: number;
  expiration_year: number;
  number_length: number;
  security_code_length: number;
  category: 'CREDIT';
  type: 'CREDIT';
  issuer: string;
  country_code: string | null;
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function detectBrand(panDigits: string): Brand {
  if (/^4\d{12,18}$/.test(panDigits)) return 'VISA';
  if (/^5[1-5]\d{14}$/.test(panDigits) || /^2(2[2-9]|[3-6]\d|7[01])\d{12}$/.test(panDigits)) {
    return 'MASTERCARD';
  }
  if (/^3[47]\d{13}$/.test(panDigits)) return 'AMEX';
  return 'UNKNOWN';
}

/**
 * Stable HMAC fingerprint over normalized PAN + expiry.
 * Same card+expiry+secret → same fingerprint (dedup testing).
 */
export function computeFingerprint(
  panDigits: string,
  expirationMonth: number,
  expirationYear: number,
  secret: string,
): string {
  const payload = `${panDigits}|${String(expirationMonth).padStart(2, '0')}|${expirationYear}`;
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function tokenizeCard(input: TokenizeInput): TokenizedCard {
  const panDigits = digitsOnly(input.pan);
  const cvvDigits = digitsOnly(input.cvv);

  if (panDigits.length < 13 || panDigits.length > 19) {
    throw new Error('invalid pan length');
  }
  if (cvvDigits.length < 3 || cvvDigits.length > 4) {
    throw new Error('invalid cvv length');
  }
  if (input.expirationMonth < 1 || input.expirationMonth > 12) {
    throw new Error('invalid expiration month');
  }
  // Accept 2-digit or 4-digit year; store as 2-digit to match pin examples.
  let year = input.expirationYear;
  if (year >= 2000) year = year % 100;
  if (year < 0 || year > 99) {
    throw new Error('invalid expiration year');
  }

  const brand = detectBrand(panDigits);
  const fingerprint = computeFingerprint(
    panDigits,
    input.expirationMonth,
    year,
    input.fingerprintSecret,
  );

  const tokenized: TokenizedCard = {
    vaulted_token: randomUUID(),
    fingerprint,
    brand,
    last4: panDigits.slice(-4),
    iin: panDigits.slice(0, 8),
    expiration_month: input.expirationMonth,
    expiration_year: year,
    number_length: panDigits.length,
    security_code_length: cvvDigits.length,
    category: 'CREDIT',
    type: 'CREDIT',
    issuer: 'MOCK BANK',
    country_code: null,
  };

  // Explicit discard — callers must not retain pan/cvv after this returns.
  return tokenized;
}
