#!/usr/bin/env node
/**
 * Deliberate refresh of contracts/yuno/openapi.json from the official URL.
 * Does not rewrite METADATA.md — print new hash/size for human review.
 * Never reads secrets.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const OFFICIAL_URL = 'https://docs.y.uno/openapi.json';
const EXPECTED_TITLE = 'Yuno Payments API';
const REQUIRED_SERVERS = [
  'https://api-sandbox.y.uno/v1',
  'https://api.y.uno/v1',
  'https://api.eu.y.uno/v1',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = join(root, 'contracts', 'yuno', 'openapi.json');
const tempPath = join(root, 'contracts', 'yuno', `openapi.json.tmp-${process.pid}`);

function fail(message) {
  console.error(`yuno:contract:update FAILED: ${message}`);
  process.exitCode = 1;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function validateDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('body is not a JSON object');
  }
  const openapi = doc.openapi;
  if (typeof openapi !== 'string' || !openapi.startsWith('3.1.')) {
    throw new Error(`expected openapi 3.1.x, got ${JSON.stringify(openapi)}`);
  }
  const title = doc.info?.title;
  if (title !== EXPECTED_TITLE) {
    throw new Error(`expected info.title ${JSON.stringify(EXPECTED_TITLE)}, got ${JSON.stringify(title)}`);
  }
  const serverUrls = new Set((doc.servers ?? []).map((s) => s?.url).filter(Boolean));
  for (const url of REQUIRED_SERVERS) {
    if (!serverUrls.has(url)) {
      throw new Error(`missing required server URL ${url}`);
    }
  }
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error('missing paths object');
  }
}

async function main() {
  console.log(`Downloading only ${OFFICIAL_URL}`);
  let response;
  try {
    response = await fetch(OFFICIAL_URL, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (error) {
    fail(`network error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (!response.ok) {
    fail(`HTTP ${response.status} ${response.statusText}`);
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    fail('downloaded body is empty');
    return;
  }

  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
    validateDocument(doc);
  } catch (error) {
    fail(`validation: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  try {
    await pipeline(Readable.from(buffer), createWriteStream(tempPath));
    await rename(tempPath, targetPath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // ignore cleanup errors
    }
    fail(`atomic replace failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const hash = sha256(buffer);
  console.log('Updated contracts/yuno/openapi.json');
  console.log(`SHA-256: ${hash}`);
  console.log(`Size:    ${buffer.length} bytes`);
  console.log('METADATA.md was NOT modified.');
  console.log('Review the diff, update contracts/yuno/METADATA.md deliberately, then run: npm run yuno:contract:verify');
}

main();
