/**
 * ISO-4217 minor-unit exponents for platform `value_minor` ↔ provider decimal.
 *
 * Source of truth for exponents:
 *   SIX Group ISO 4217 maintenance agency currency list
 *   https://www.six-group.com/en/products-services/financial-information/data-standards.html
 *   (ISO 4217 Amendment / current currency codes list — “CcyMnrUnts” / minor units column)
 *
 * Never hardcode divide-by-100. Look up the currency exponent, then scale.
 * Currencies not in the table reject until explicitly added.
 */

export type CurrencyCode = string;

/** Subset required by F6 acceptance + common LatAm/test currencies. */
const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = {
  // Zero-decimal
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  // Two-decimal (default for most)
  USD: 2,
  EUR: 2,
  GBP: 2,
  COP: 2,
  MXN: 2,
  BRL: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  // Three-decimal
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
};

export const ISO_4217_EXPONENT_SOURCE =
  'SIX Group ISO 4217 currency codes list (CcyMnrUnts / minor units)';

export function currencyExponent(currency: CurrencyCode): number {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`invalid currency code: ${currency}`);
  }
  const exp = ISO_4217_MINOR_UNITS[code];
  if (exp === undefined) {
    throw new Error(
      `unsupported currency ${code}: add ISO-4217 minor units from ${ISO_4217_EXPONENT_SOURCE}`,
    );
  }
  return exp;
}

/** Platform integer minor units → provider decimal major units. */
export function minorToMajor(valueMinor: number, currency: CurrencyCode): number {
  if (!Number.isInteger(valueMinor) || valueMinor < 0) {
    throw new Error('value_minor must be a non-negative integer');
  }
  const exp = currencyExponent(currency);
  if (exp === 0) return valueMinor;
  const divisor = 10 ** exp;
  return valueMinor / divisor;
}

/** Provider decimal major units → platform integer minor units (exact when representable). */
export function majorToMinor(valueMajor: number, currency: CurrencyCode): number {
  if (!Number.isFinite(valueMajor) || valueMajor < 0) {
    throw new Error('amount value must be a non-negative finite number');
  }
  const exp = currencyExponent(currency);
  if (exp === 0) {
    if (!Number.isInteger(valueMajor)) {
      throw new Error(`zero-decimal currency ${currency} requires an integer major amount`);
    }
    return valueMajor;
  }
  const factor = 10 ** exp;
  const minor = Math.round(valueMajor * factor);
  // Guard float drift for exact exponents.
  const back = minor / factor;
  if (Math.abs(back - valueMajor) > 1e-9 * Math.max(1, Math.abs(valueMajor))) {
    throw new Error(`amount value is not an exact ${exp}-decimal for ${currency}`);
  }
  return minor;
}
