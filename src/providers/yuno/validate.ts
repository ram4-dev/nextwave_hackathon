/**
 * Handwritten Yuno contract validator facade.
 * Uses generated MVP schemas only — never reads contracts/yuno/openapi.json
 * or fetches live docs at runtime.
 *
 * Observed pin gaps (evidence-backed; not invented fields):
 * - Response bodies often use overlapping `oneOf` object branches without a
 *   discriminator (e.g. create-customer 201). Strict oneOf rejects payloads that
 *   match more than one branch; response validation tolerates ≥1 matching branch.
 * - POST /payments lists `checkout` in JSON Schema `required`, while the same
 *   property description says checkout is not required for DIRECT/REDIRECT.
 *   Request validation follows the pinned schema `required` array.
 * - Several string fields document MIN/MAX lengths only in prose, without
 *   JSON Schema minLength/maxLength — Ajv will not enforce those prose limits.
 * - create-payment / retrieve-payment-by-id-v2 / F5 post-pay action responses:
 *   request `amount.value` is float, but success response example schemas type
 *   amount fields as `integer`. Response validation re-checks with amount
 *   integer→number relaxation only for those documented operations when the
 *   strict schema fails solely for that mismatch.
 */
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import {
  YUNO_COMPONENT_SCHEMAS,
  YUNO_MVP_OPERATION_KEYS,
  YUNO_MVP_OPERATIONS,
  type YunoMvpOperationKey,
} from './generated/mvp-operations.js';

type AjvLike = {
  addSchema: (schema: object) => unknown;
  compile: (schema: object) => ValidateFunction;
};

// CJS/ESM interop for ajv@8 / ajv-formats@3 under NodeNext.
const Ajv2020 =
  (Ajv2020Import as unknown as { default?: new (options?: object) => AjvLike }).default ??
  (Ajv2020Import as unknown as new (options?: object) => AjvLike);
const addFormats =
  (addFormatsImport as unknown as { default?: (ajv: AjvLike) => unknown }).default ??
  (addFormatsImport as unknown as (ajv: AjvLike) => unknown);

export type YunoValidationIssue = {
  path: string;
  message: string;
  keyword?: string;
};

export type YunoValidationResult =
  | { ok: true }
  | { ok: false; operationKey: YunoMvpOperationKey; issues: YunoValidationIssue[] };

let ajvSingleton: AjvLike | undefined;

function getAjv(): AjvLike {
  if (ajvSingleton) return ajvSingleton;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: true,
    // OpenAPI payloads frequently omit properties that schemas leave optional.
    removeAdditional: false,
  });
  addFormats(ajv);
  for (const schema of Object.values(YUNO_COMPONENT_SCHEMAS)) {
    ajv.addSchema(schema);
  }
  ajvSingleton = ajv;
  return ajv;
}

function compileAndValidate(
  ajv: AjvLike,
  schema: Record<string, unknown>,
  data: unknown,
): { valid: boolean; errors: YunoValidationIssue[]; toleratedOverlappingOneOf: boolean } {
  const validate = ajv.compile(schema);
  if (validate(data)) {
    return { valid: true, errors: [], toleratedOverlappingOneOf: false };
  }

  const ajvErrors = validate.errors ?? [];
  const oneOfBranches = schema.oneOf;
  const onlyOneOfFailure =
    ajvErrors.length === 1 &&
    ajvErrors[0]?.keyword === 'oneOf' &&
    Array.isArray(oneOfBranches);

  // Pin gap: some success responses use overlapping oneOf object branches
  // (e.g. create-customer 201 "full" vs "min" data) so a valid payload can
  // match more than one branch and fail strict oneOf. Accept when ≥1 branch matches.
  if (onlyOneOfFailure) {
    let matches = 0;
    for (const branch of oneOfBranches) {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue;
      const branchValidate = ajv.compile(branch as Record<string, unknown>);
      if (branchValidate(data)) matches += 1;
    }
    if (matches >= 1) {
      return { valid: true, errors: [], toleratedOverlappingOneOf: true };
    }
  }

  return { valid: false, errors: formatIssues(ajvErrors), toleratedOverlappingOneOf: false };
}

function formatIssues(errors: ErrorObject[] | null | undefined): YunoValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [{ path: '', message: 'validation failed without Ajv error details' }];
  }
  return errors.map((error) => ({
    path: error.instancePath || error.schemaPath || '',
    message: error.message ?? 'invalid',
    keyword: error.keyword,
  }));
}

/** Ops where response example schemas type provider amount fields as integer. */
const AMOUNT_INTEGER_RESPONSE_GAP_OPS = new Set<YunoMvpOperationKey>([
  'create-payment',
  'retrieve-payment-by-id-v2',
  // F5 post-pay responses reuse the same integer amount example schemas.
  'capture-authorization',
  'cancel-payment',
  'refund-payment',
  'cancel-or-refund-a-payment',
  'cancel-or-refund-payment-with-transaction',
]);

/**
 * Narrow pin-gap transform: under amount-related property names only, change
 * JSON Schema `type: "integer"` to `type: "number"` so fractional provider
 * decimals (valid on the request schema) are not rejected on response checks.
 * Does not relax any other constraints.
 */
function relaxAmountIntegerTypes(node: unknown, parentKey?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => relaxAmountIntegerTypes(item, parentKey));
  }
  if (!node || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'type' && value === 'integer') {
      const amountField =
        parentKey === 'amount' ||
        parentKey === 'value' ||
        parentKey === 'captured' ||
        parentKey === 'refunded';
      out[key] = amountField ? 'number' : value;
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const propsIn: Record<string, unknown> = {
        ...(value as Record<string, unknown>),
      };
      const propsOut: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(propsIn)) {
        propsOut[propName] = relaxAmountIntegerTypes(propSchema, propName);
      }
      out[key] = propsOut;
      continue;
    }
    out[key] = relaxAmountIntegerTypes(value, key === 'items' ? parentKey : key);
  }
  return out;
}

function assertOperationKey(operationKey: string): asserts operationKey is YunoMvpOperationKey {
  if (!(YUNO_MVP_OPERATION_KEYS as readonly string[]).includes(operationKey)) {
    throw new Error(`Unknown Yuno MVP operation key: ${operationKey}`);
  }
}

function headerMap(headers: Record<string, string | undefined> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    map.set(name.toLowerCase(), value);
  }
  return map;
}

function validateRequiredHeaders(
  operationKey: YunoMvpOperationKey,
  headers: Record<string, string | undefined> | undefined,
): YunoValidationIssue[] {
  const operation = YUNO_MVP_OPERATIONS[operationKey];
  const present = headerMap(headers);
  const issues: YunoValidationIssue[] = [];
  for (const requirement of operation.requiredHeaders) {
    if (!requirement.required) continue;
    const value = present.get(requirement.name.toLowerCase());
    if (value === undefined || value.trim() === '') {
      issues.push({
        path: `/headers/${requirement.name}`,
        message: `missing required header ${requirement.name}`,
        keyword: 'required',
      });
    }
  }
  return issues;
}

export function listYunoMvpOperationKeys(): readonly YunoMvpOperationKey[] {
  return YUNO_MVP_OPERATION_KEYS;
}

export function getYunoMvpOperation(operationKey: YunoMvpOperationKey) {
  assertOperationKey(operationKey);
  return YUNO_MVP_OPERATIONS[operationKey];
}

/**
 * Validate request headers (when provided) and JSON body against the pinned
 * operation schema. Operations without a request JSON schema must not send a body.
 */
export function validateRequest(
  operationKey: YunoMvpOperationKey,
  body: unknown,
  headers?: Record<string, string | undefined>,
): YunoValidationResult {
  assertOperationKey(operationKey);
  const operation = YUNO_MVP_OPERATIONS[operationKey];
  const issues = validateRequiredHeaders(operationKey, headers);

  if (!operation.requestSchema) {
    if (body !== undefined && body !== null) {
      issues.push({
        path: '',
        message: 'operation has no application/json request schema; body must be omitted',
        keyword: 'requestBody',
      });
    }
    return issues.length === 0 ? { ok: true } : { ok: false, operationKey, issues };
  }

  const ajv = getAjv();
  const result = compileAndValidate(ajv, operation.requestSchema, body);
  if (!result.valid) {
    issues.push(...result.errors);
  }

  return issues.length === 0 ? { ok: true } : { ok: false, operationKey, issues };
}

/**
 * Validate a response status + JSON body. Statuses without an application/json
 * schema in the pin are accepted without body schema checks (documented gap
 * tolerance); unknown statuses fail.
 */
export function validateResponse(
  operationKey: YunoMvpOperationKey,
  status: number | string,
  body: unknown,
): YunoValidationResult {
  assertOperationKey(operationKey);
  const operation = YUNO_MVP_OPERATIONS[operationKey];
  const statusKey = String(status);

  if (!operation.responseStatuses.includes(statusKey)) {
    return {
      ok: false,
      operationKey,
      issues: [
        {
          path: '/status',
          message: `status ${statusKey} is not documented for ${operationKey}; expected one of ${operation.responseStatuses.join(', ')}`,
          keyword: 'status',
        },
      ],
    };
  }

  const schema = operation.responseSchemas[statusKey];
  if (!schema) {
    // Pin documents the status but no application/json schema — tolerate any body.
    return { ok: true };
  }

  const ajv = getAjv();
  const result = compileAndValidate(ajv, schema, body);
  if (result.valid) {
    return { ok: true };
  }

  // Pin gap: create/retrieve payment response schemas type amount fields as
  // integer while the create request permits float. Re-validate once with a
  // narrowly relaxed amount integer→number schema; other failures still reject.
  if (AMOUNT_INTEGER_RESPONSE_GAP_OPS.has(operationKey)) {
    const relaxed = relaxAmountIntegerTypes(schema) as Record<string, unknown>;
    const retry = compileAndValidate(ajv, relaxed, body);
    if (retry.valid) {
      return { ok: true };
    }
    return { ok: false, operationKey, issues: retry.errors };
  }

  return { ok: false, operationKey, issues: result.errors };
}
