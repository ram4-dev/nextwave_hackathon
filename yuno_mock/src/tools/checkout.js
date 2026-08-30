// Tools for the `checkout` category. Full input/output reference:
// docs/tools-reference.md. Fidelity against docs.y.uno and the real SDK:
// docs/scope-and-fidelity.md.
//
// checkoutSessionRetrievePaymentMethods returns a DIRECT ARRAY of methods
// (not wrapped in an object) — confirmed by Yuno's official docs — with the
// shape that comes out of the country→methods table in payment-methods.js.

import { z } from 'zod';
import { ok, fail } from '../mcp-result.js';
import {
  createCheckoutSession,
  getCheckoutSession,
  getCustomerById,
  getMerchantById,
} from '../store.js';
import { paymentMethodsForCountry } from '../payment-methods.js';

export function registerCheckoutTools(server) {
  server.registerTool(
    'checkoutSessionCreate',
    {
      description: 'Create a checkout session', // README.md:303
      inputSchema: {
        amount: z.number().positive(),
        currency: z.string(),
        country: z.string(),
        merchant_order_id: z.string(),
        description: z.string().optional(),
        customer_id: z.string().optional(),
        // merchant_id: not a real field from Yuno's docs — it's the
        // merchant directory cascading (same pattern as customer_id) into
        // the payments created from this session.
        merchant_id: z.string().optional(),
      },
    },
    async ({ amount, currency, country, merchant_order_id, description, customer_id, merchant_id }) => {
      if (customer_id && !getCustomerById(customer_id)) {
        return fail(`No existe un customer con id "${customer_id}"`);
      }
      if (merchant_id && !getMerchantById(merchant_id)) {
        return fail(`No existe un merchant con id "${merchant_id}"`);
      }

      const session = createCheckoutSession({
        amount,
        currency,
        country,
        merchant_order_id,
        description,
        customer_id,
        merchant_id,
      });
      return ok(session);
    },
  );

  server.registerTool(
    'checkoutSessionRetrievePaymentMethods',
    {
      description: 'Get available payment methods', // README.md:305
      inputSchema: {
        checkout_session: z.string(),
      },
    },
    async ({ checkout_session }) => {
      const session = getCheckoutSession(checkout_session);
      if (!session) return fail(`No existe un checkout_session "${checkout_session}"`);

      return ok(paymentMethodsForCountry(session.country));
    },
  );
}
