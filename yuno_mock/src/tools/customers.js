// Tools for the `customers` category. Full input/output reference:
// docs/tools-reference.md. Fidelity against docs.y.uno and the real SDK:
// docs/scope-and-fidelity.md.
//
// The merchant's external customer identifier is called `merchant_customer_id`
// (confirmed against docs.y.uno/reference/customers/create-customer and
// .../retrieve-customer-by-external-id) — not `external_id`.

import { z } from 'zod';
import {
  createCustomer,
  getCustomerById,
  getCustomerByMerchantCustomerId,
  updateCustomer,
  DuplicateMerchantCustomerIdError,
} from '../store.js';
import { ok, fail } from '../mcp-result.js';

export function registerCustomerTools(server) {
  server.registerTool(
    'customerCreate',
    {
      description: 'Create a new customer', // README.md:286
      inputSchema: {
        first_name: z.string(),
        last_name: z.string(),
        email: z.string().email(),
        phone: z.string().optional(),
        merchant_customer_id: z
          .string()
          .optional()
          .describe("The customer's id in the merchant's own system"),
      },
    },
    async ({ first_name, last_name, email, phone, merchant_customer_id }) => {
      try {
        const customer = createCustomer({ first_name, last_name, email, phone, merchant_customer_id });
        return ok(customer);
      } catch (error) {
        if (error instanceof DuplicateMerchantCustomerIdError) return fail(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    'customerRetrieve',
    {
      description: 'Retrieve customer by ID', // README.md:287
      inputSchema: {
        customer_id: z.string(),
      },
    },
    async ({ customer_id }) => {
      const customer = getCustomerById(customer_id);
      if (!customer) return fail(`No existe un customer con id "${customer_id}"`);
      return ok(customer);
    },
  );

  server.registerTool(
    'customerRetrieveByExternalId',
    {
      description: 'Retrieve by external ID', // README.md:288
      inputSchema: {
        merchant_customer_id: z.string(),
      },
    },
    async ({ merchant_customer_id }) => {
      const customer = getCustomerByMerchantCustomerId(merchant_customer_id);
      if (!customer) {
        return fail(`No existe un customer con merchant_customer_id "${merchant_customer_id}"`);
      }
      return ok(customer);
    },
  );

  server.registerTool(
    'customerUpdate',
    {
      description: 'Update customer information', // README.md:289
      inputSchema: {
        customer_id: z.string(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
      },
    },
    async ({ customer_id, ...patch }) => {
      const fields = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      );
      const updated = updateCustomer(customer_id, fields);
      if (!updated) return fail(`No existe un customer con id "${customer_id}"`);
      return ok(updated);
    },
  );
}
