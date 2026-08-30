import { randomUUID } from 'node:crypto';

/** Yuno-style UUID ids (pin examples use UUID format). */
export function newYunoId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
