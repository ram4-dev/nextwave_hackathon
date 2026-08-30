#!/usr/bin/env node
/**
 * Verify the pinned Yuno OpenAPI snapshot against METADATA.md and MVP coverage.
 * Never reads secrets.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { YUNO_MVP_OPERATIONS } from './yuno-mvp-operations.mjs';

const EXPECTED_TITLE = 'Yuno Payments API';
const EXPECTED_INFO_VERSION = '1.0.0';
const REQUIRED_SERVERS = [
  'https://api-sandbox.y.uno/v1',
  'https://api.y.uno/v1',
  'https://api.eu.y.uno/v1',
];
const REQUIRED_SECURITY_SCHEMES = [
  'PublicApiKey',
  'PrivateSecretKey',
  'IdempotencyKey',
];
const REQUIRED_SECURITY_HEADERS = {
  PublicApiKey: 'public-api-key',
  PrivateSecretKey: 'private-secret-key',
  IdempotencyKey: 'X-Idempotency-Key',
};
/** Floors match the current pin; bumps only via deliberate metadata + snapshot review. */
const MIN_PATHS = 119;
const MIN_SCHEMAS = 50;
const MIN_WEBHOOKS = 1;

/** MVP coverage — shared with generate-yuno-contract.mjs */
const REQUIRED_MVP_OPERATIONS = YUNO_MVP_OPERATIONS;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const openapiPath = join(root, 'contracts', 'yuno', 'openapi.json');
const metadataPath = join(root, 'contracts', 'yuno', 'METADATA.md');

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extractMetadataField(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*\`([^\`]+)\`\\s*\\|`);
  const match = markdown.match(re);
  return match?.[1];
}

function hasOperation(paths, method, pathKey) {
  const item = paths?.[pathKey];
  if (!item || typeof item !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(item, method);
}

async function main() {
  let openapiBuffer;
  let metadataText;
  try {
    openapiBuffer = await readFile(openapiPath);
  } catch {
    fail(`cannot read ${openapiPath}`);
    process.exitCode = 1;
    return;
  }
  try {
    metadataText = await readFile(metadataPath, 'utf8');
  } catch {
    fail(`cannot read ${metadataPath}`);
    process.exitCode = 1;
    return;
  }

  const actualHash = sha256(openapiBuffer);
  const actualSize = openapiBuffer.length;
  const metaHash = extractMetadataField(metadataText, 'SHA-256');
  const metaSizeRaw = extractMetadataField(metadataText, 'Byte size');
  const metaSize = metaSizeRaw ? Number(metaSizeRaw) : NaN;

  if (!metaHash) {
    fail('METADATA.md missing SHA-256 field');
  } else if (metaHash !== actualHash) {
    fail(`hash mismatch: metadata ${metaHash} vs file ${actualHash}`);
  } else {
    ok(`SHA-256 matches (${actualHash})`);
  }

  if (!Number.isFinite(metaSize)) {
    fail('METADATA.md missing or invalid Byte size field');
  } else if (metaSize !== actualSize) {
    fail(`size mismatch: metadata ${metaSize} vs file ${actualSize}`);
  } else {
    ok(`byte size matches (${actualSize})`);
  }

  let doc;
  try {
    doc = JSON.parse(openapiBuffer.toString('utf8'));
  } catch (error) {
    fail(`openapi.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.1.')) {
    fail(`expected openapi 3.1.x, got ${JSON.stringify(doc.openapi)}`);
  } else {
    ok(`openapi ${doc.openapi}`);
  }

  if (doc.info?.title !== EXPECTED_TITLE) {
    fail(`expected info.title ${JSON.stringify(EXPECTED_TITLE)}, got ${JSON.stringify(doc.info?.title)}`);
  } else {
    ok(`title ${EXPECTED_TITLE}`);
  }

  if (doc.info?.version !== EXPECTED_INFO_VERSION) {
    fail(`expected info.version ${JSON.stringify(EXPECTED_INFO_VERSION)}, got ${JSON.stringify(doc.info?.version)}`);
  } else {
    ok(`info.version ${EXPECTED_INFO_VERSION}`);
  }

  const serverUrls = new Set((doc.servers ?? []).map((s) => s?.url).filter(Boolean));
  for (const url of REQUIRED_SERVERS) {
    if (!serverUrls.has(url)) {
      fail(`missing official server ${url}`);
    }
  }
  if ([...REQUIRED_SERVERS].every((url) => serverUrls.has(url))) {
    ok('official servers present');
  }

  const schemes = doc.components?.securitySchemes ?? {};
  for (const id of REQUIRED_SECURITY_SCHEMES) {
    const scheme = schemes[id];
    if (!scheme) {
      fail(`missing security scheme ${id}`);
      continue;
    }
    const expectedHeader = REQUIRED_SECURITY_HEADERS[id];
    if (scheme.type !== 'apiKey' || scheme.in !== 'header' || scheme.name !== expectedHeader) {
      fail(
        `security scheme ${id} expected apiKey header ${expectedHeader}, got type=${scheme.type} in=${scheme.in} name=${scheme.name}`,
      );
    }
  }
  if (REQUIRED_SECURITY_SCHEMES.every((id) => schemes[id])) {
    ok('required security schemes present');
  }

  const pathCount = Object.keys(doc.paths ?? {}).length;
  const schemaCount = Object.keys(doc.components?.schemas ?? {}).length;
  const webhookCount = Object.keys(doc.webhooks ?? {}).length;

  if (pathCount < MIN_PATHS) {
    fail(`paths count ${pathCount} < minimum ${MIN_PATHS}`);
  } else {
    ok(`paths ${pathCount} (>= ${MIN_PATHS})`);
  }
  if (schemaCount < MIN_SCHEMAS) {
    fail(`schemas count ${schemaCount} < minimum ${MIN_SCHEMAS}`);
  } else {
    ok(`schemas ${schemaCount} (>= ${MIN_SCHEMAS})`);
  }
  if (webhookCount < MIN_WEBHOOKS) {
    fail(`webhooks count ${webhookCount} < minimum ${MIN_WEBHOOKS}`);
  } else {
    ok(`webhooks ${webhookCount} (>= ${MIN_WEBHOOKS})`);
  }

  let missingOps = 0;
  for (const [method, pathKey] of REQUIRED_MVP_OPERATIONS) {
    if (!hasOperation(doc.paths, method, pathKey)) {
      fail(`missing MVP operation ${method.toUpperCase()} ${pathKey}`);
      missingOps += 1;
    }
  }
  if (missingOps === 0) {
    ok(`MVP operations present (${REQUIRED_MVP_OPERATIONS.length})`);
  }

  if (failures.length > 0) {
    console.error(`\nyuno:contract:verify FAILED (${failures.length} check(s))`);
    process.exitCode = 1;
    return;
  }

  console.log('\nyuno:contract:verify passed');
}

main();
