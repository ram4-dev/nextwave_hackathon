/** Deterministic Checkout availability fixtures for CO / MX / BR only. */

export type AvailabilityMethod = {
  category: string;
  type: string;
  name: string;
  description: string;
  icon: string;
};

const CARD_VISA: AvailabilityMethod = {
  category: 'CARD',
  type: 'VISA',
  name: 'Visa Credit Card',
  description: 'Visa Credit Card',
  icon: 'https://icons.prod.y.uno/visa_logosimbolo.png',
};

const CARD_MASTERCARD: AvailabilityMethod = {
  category: 'CARD',
  type: 'MASTERCARD',
  name: 'Mastercard Credit Card',
  description: 'Mastercard Credit Card',
  icon: 'https://icons.prod.y.uno/mastercard_logosimbolo.png',
};

const BY_COUNTRY: Record<string, AvailabilityMethod[]> = {
  CO: [CARD_VISA, CARD_MASTERCARD],
  MX: [CARD_VISA, CARD_MASTERCARD],
  BR: [CARD_VISA, CARD_MASTERCARD],
};

export function availabilityForCountry(country: string): AvailabilityMethod[] {
  return BY_COUNTRY[country] ? [...BY_COUNTRY[country]!] : [];
}

export function isCatalogCountry(country: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_COUNTRY, country);
}
