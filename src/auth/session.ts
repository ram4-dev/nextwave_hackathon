/**
 * Compatibility re-export for payment tests and callers that import session helpers
 * from `auth/session`. Canonical SIWE + session implementation lives in `auth/siwe`.
 */
export { issueSessionToken, verifySessionToken } from './siwe.js';
