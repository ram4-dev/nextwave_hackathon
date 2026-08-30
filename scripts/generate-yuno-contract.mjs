#!/usr/bin/env node
/**
 * Generate Yuno contract TypeScript types + MVP operation registry
 * from the pinned contracts/yuno/openapi.json only (no live fetch).
 *
 * Usage:
 *   node scripts/generate-yuno-contract.mjs           # write outputs
 *   node scripts/generate-yuno-contract.mjs --check   # drift check; no writes
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import openapiTS, { astToString } from 'openapi-typescript';
import { YUNO_MVP_OPERATIONS } from './yuno-mvp-operations.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const openapiPath = join(root, 'contracts', 'yuno', 'openapi.json');
const outDir = join(root, 'src', 'providers', 'yuno', 'generated');

const GENERATED_BANNER = `/**
 * AUTO-GENERATED FILE — do not edit by hand.
 * Source: contracts/yuno/openapi.json (pinned snapshot only).
 * Regenerate: npm run yuno:contract:generate
 * Drift check: npm run yuno:contract:check-generated
 */

`;

const COMPONENT_ID_PREFIX = 'https://contracts.yuno.local';

function localRefToSchemaId(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`only local JSON Pointer refs are supported, got ${JSON.stringify(ref)}`);
  }
  return `${COMPONENT_ID_PREFIX}/${ref.slice(2)}`;
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  console.error(`yuno:contract:generate FAILED: ${message}`);
  process.exitCode = 1;
}

function decodePointerToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolvePointer(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`only local JSON Pointer refs are supported, got ${JSON.stringify(ref)}`);
  }
  const parts = ref.slice(2).split('/').map(decodePointerToken);
  let cur = doc;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) {
      throw new Error(`unresolvable ref ${ref}`);
    }
    cur = cur[part];
  }
  return cur;
}

function collectLocalRefs(node, refs = new Set()) {
  if (!node || typeof node !== 'object') return refs;
  if (Array.isArray(node)) {
    for (const item of node) collectLocalRefs(item, refs);
    return refs;
  }
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    refs.add(node.$ref);
  }
  for (const value of Object.values(node)) {
    collectLocalRefs(value, refs);
  }
  return refs;
}

function rewriteLocalRefs(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(rewriteLocalRefs);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
      out[key] = localRefToSchemaId(value);
    } else {
      out[key] = rewriteLocalRefs(value);
    }
  }
  return out;
}

function stableStringify(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  }, 2);
}

function mergeParameters(pathItem, operation) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
}

function expandParameter(doc, param) {
  if (param && typeof param === 'object' && typeof param.$ref === 'string') {
    return expandParameter(doc, resolvePointer(doc, param.$ref));
  }
  return param;
}

function requiredHeadersForOperation(doc, pathItem, operation) {
  const headers = new Map();

  const security = operation.security ?? doc.security ?? [];
  for (const requirement of security) {
    for (const schemeId of Object.keys(requirement ?? {})) {
      const scheme = doc.components?.securitySchemes?.[schemeId];
      if (scheme?.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
        headers.set(scheme.name, {
          name: scheme.name,
          required: true,
          source: 'security',
          schemeId,
        });
      }
    }
  }

  for (const raw of mergeParameters(pathItem, operation)) {
    const param = expandParameter(doc, raw);
    if (param?.in === 'header' && typeof param.name === 'string') {
      const existing = headers.get(param.name);
      headers.set(param.name, {
        name: param.name,
        required: Boolean(param.required) || existing?.required === true,
        source: existing ? `${existing.source}+parameter` : 'parameter',
        schemeId: existing?.schemeId,
      });
    }
  }

  return [...headers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function securityRequirements(doc, operation) {
  const security = operation.security ?? doc.security ?? [];
  return security.map((requirement) =>
    Object.keys(requirement ?? {}).sort().map((schemeId) => {
      const scheme = doc.components?.securitySchemes?.[schemeId];
      return {
        schemeId,
        headerName: scheme?.type === 'apiKey' && scheme.in === 'header' ? scheme.name : null,
      };
    }),
  );
}

function jsonMediaSchema(content) {
  if (!content || typeof content !== 'object') return null;
  const media = content['application/json'];
  if (!media || typeof media !== 'object') return null;
  return media.schema ?? null;
}

function buildReachableComponentSchemas(doc, seedSchemas) {
  const pending = new Set();
  for (const schema of seedSchemas) {
    if (schema) collectLocalRefs(schema, pending);
  }

  const resolved = new Map();
  while (pending.size > 0) {
    const ref = pending.values().next().value;
    pending.delete(ref);
    if (resolved.has(ref)) continue;
    const target = resolvePointer(doc, ref);
    resolved.set(ref, target);
    collectLocalRefs(target, pending);
  }

  const components = {};
  for (const [ref, schema] of [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const id = localRefToSchemaId(ref);
    components[id] = {
      $id: id,
      ...rewriteLocalRefs(schema),
    };
  }
  return components;
}

function buildMvpRegistry(doc, openapiSha256) {
  const seedSchemas = [];
  const operations = {};

  for (const [method, path] of YUNO_MVP_OPERATIONS) {
    const pathItem = doc.paths?.[path];
    const operation = pathItem?.[method];
    if (!operation) {
      throw new Error(`missing MVP operation ${method.toUpperCase()} ${path}`);
    }
    const operationId = operation.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Error(`MVP operation ${method.toUpperCase()} ${path} lacks operationId`);
    }
    if (operations[operationId]) {
      throw new Error(`duplicate operationId ${operationId}`);
    }

    const requestSchema = jsonMediaSchema(operation.requestBody?.content);
    const responseStatuses = Object.keys(operation.responses ?? {}).sort();
    const responseSchemas = {};
    for (const status of responseStatuses) {
      const response = operation.responses[status];
      const schema = jsonMediaSchema(response?.content);
      if (schema) {
        responseSchemas[status] = rewriteLocalRefs(schema);
        seedSchemas.push(schema);
      }
    }
    if (requestSchema) seedSchemas.push(requestSchema);

    operations[operationId] = {
      key: operationId,
      operationId,
      method: method.toUpperCase(),
      path,
      requiredHeaders: requiredHeadersForOperation(doc, pathItem, operation),
      security: securityRequirements(doc, operation),
      requestSchema: requestSchema ? rewriteLocalRefs(requestSchema) : null,
      responseStatuses,
      responseSchemas,
    };
  }

  if (Object.keys(operations).length !== YUNO_MVP_OPERATIONS.length) {
    throw new Error(
      `expected ${YUNO_MVP_OPERATIONS.length} operations, got ${Object.keys(operations).length}`,
    );
  }

  return {
    sourceOpenApiSha256: openapiSha256,
    componentIdPrefix: COMPONENT_ID_PREFIX,
    componentSchemas: buildReachableComponentSchemas(doc, seedSchemas),
    operations,
    operationKeys: Object.keys(operations).sort(),
  };
}

function renderMvpOperationsTs(registry) {
  return `${GENERATED_BANNER}export const YUNO_GENERATED_SOURCE_OPENAPI_SHA256 = ${JSON.stringify(registry.sourceOpenApiSha256)} as const;

export const YUNO_COMPONENT_ID_PREFIX = ${JSON.stringify(registry.componentIdPrefix)} as const;

export const YUNO_MVP_OPERATION_KEYS = ${stableStringify(registry.operationKeys)} as const;

export type YunoMvpOperationKey = (typeof YUNO_MVP_OPERATION_KEYS)[number];

export type YunoGeneratedHeaderRequirement = {
  name: string;
  required: boolean;
  source: string;
  schemeId?: string;
};

export type YunoGeneratedSecurityRequirement = {
  schemeId: string;
  headerName: string | null;
};

export type YunoMvpOperation = {
  key: YunoMvpOperationKey;
  operationId: string;
  method: string;
  path: string;
  requiredHeaders: YunoGeneratedHeaderRequirement[];
  security: YunoGeneratedSecurityRequirement[][];
  requestSchema: Record<string, unknown> | null;
  responseStatuses: string[];
  responseSchemas: Record<string, Record<string, unknown>>;
};

export const YUNO_COMPONENT_SCHEMAS: Record<string, Record<string, unknown>> = ${stableStringify(registry.componentSchemas)};

export const YUNO_MVP_OPERATIONS: Record<YunoMvpOperationKey, YunoMvpOperation> = ${stableStringify(registry.operations)} as Record<YunoMvpOperationKey, YunoMvpOperation>;
`;
}

function renderManifestTs(manifest) {
  return `${GENERATED_BANNER}export const YUNO_GENERATED_MANIFEST = ${stableStringify(manifest)} as const;
`;
}

function renderIndexTs() {
  return `${GENERATED_BANNER}export type { paths, components, operations, webhooks } from './openapi-types.js';
export {
  YUNO_GENERATED_SOURCE_OPENAPI_SHA256,
  YUNO_COMPONENT_ID_PREFIX,
  YUNO_MVP_OPERATION_KEYS,
  YUNO_COMPONENT_SCHEMAS,
  YUNO_MVP_OPERATIONS,
} from './mvp-operations.js';
export type {
  YunoMvpOperationKey,
  YunoMvpOperation,
  YunoGeneratedHeaderRequirement,
  YunoGeneratedSecurityRequirement,
} from './mvp-operations.js';
export { YUNO_GENERATED_MANIFEST } from './manifest.js';
`;
}

async function buildOutputs() {
  const openapiBuffer = await readFile(openapiPath);
  const openapiSha256 = sha256Hex(openapiBuffer);
  const doc = JSON.parse(openapiBuffer.toString('utf8'));

  const ast = await openapiTS(doc, {
    // Deterministic, local-only: never follow remote $refs.
    silent: true,
  });
  const typesSource = `${GENERATED_BANNER}${astToString(ast)}`;

  const registry = buildMvpRegistry(doc, openapiSha256);
  const mvpSource = renderMvpOperationsTs(registry);
  const indexSource = renderIndexTs();

  const files = {
    'openapi-types.ts': typesSource,
    'mvp-operations.ts': mvpSource,
    'index.ts': indexSource,
  };

  const artifactHashes = {};
  for (const [name, content] of Object.entries(files)) {
    artifactHashes[name] = sha256Hex(Buffer.from(content, 'utf8'));
  }

  const manifest = {
    sourceOpenApiPath: 'contracts/yuno/openapi.json',
    sourceOpenApiSha256: openapiSha256,
    generator: 'scripts/generate-yuno-contract.mjs',
    openapiTypescript: '7.13.0',
    mvpOperationCount: YUNO_MVP_OPERATIONS.length,
    // Hashes for regenerateable artifacts only (excludes this manifest file).
    fileHashes: artifactHashes,
  };
  files['manifest.ts'] = renderManifestTs(manifest);

  return { files, openapiSha256, operationKeys: registry.operationKeys };
}

async function writeOutputs(files, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(destinationDir, name), content, 'utf8');
  }
}

async function readTrackedOutputs() {
  const names = ['openapi-types.ts', 'mvp-operations.ts', 'manifest.ts', 'index.ts'];
  const files = {};
  for (const name of names) {
    files[name] = await readFile(join(outDir, name), 'utf8');
  }
  return files;
}

async function checkDrift(files) {
  let tracked;
  try {
    tracked = await readTrackedOutputs();
  } catch (error) {
    fail(
      `cannot read tracked generated outputs under ${relative(root, outDir)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const names = Object.keys(files).sort();
  const trackedNames = Object.keys(tracked).sort();
  if (names.join('\n') !== trackedNames.join('\n')) {
    fail(`file set drift. expected [${names.join(', ')}], tracked [${trackedNames.join(', ')}]`);
    return;
  }

  let drifted = 0;
  for (const name of names) {
    if (files[name] !== tracked[name]) {
      console.error(`DRIFT: ${relative(root, join(outDir, name))}`);
      drifted += 1;
    } else {
      console.log(`OK: ${name}`);
    }
  }

  if (drifted > 0) {
    fail(`${drifted} generated file(s) differ from npm run yuno:contract:generate output`);
    return;
  }
  console.log('yuno:contract:check-generated passed (no drift)');
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  let outputs;
  try {
    outputs = await buildOutputs();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  console.log(`Source SHA-256: ${outputs.openapiSha256}`);
  console.log(`MVP operation keys (${outputs.operationKeys.length}): ${outputs.operationKeys.join(', ')}`);

  if (checkOnly) {
    // Generate only in memory / optional temp for inspection — never mutate tracked outputs.
    const temp = join(tmpdir(), `yuno-gen-check-${process.pid}`);
    try {
      await writeOutputs(outputs.files, temp);
      await checkDrift(outputs.files);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return;
  }

  await writeOutputs(outputs.files, outDir);
  for (const name of Object.keys(outputs.files).sort()) {
    console.log(`Wrote ${relative(root, join(outDir, name))}`);
  }
  console.log('yuno:contract:generate completed');
}

main();
