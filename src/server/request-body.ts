import { DomainError } from '../domain/state-machine.js';

export const MAX_KYA_BODY_BYTES = 32_768;

export type RequestBodySource = {
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
};

/**
 * Read at most maxBytes from a request stream. The reader is cancelled as soon
 * as the bound is crossed, so an untrusted client cannot force full buffering
 * merely by omitting or lying about Content-Length.
 */
export async function readBoundedBody(
  source: RequestBodySource,
  maxBytes = MAX_KYA_BODY_BYTES,
): Promise<Uint8Array> {
  const contentLength = source.headers.get('content-length');
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new DomainError('Payload too large', 'PAYLOAD_TOO_LARGE');
    }
  }
  if (!source.body) return new Uint8Array();

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DomainError('Payload too large', 'PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(
  source: RequestBodySource,
  maxBytes = MAX_KYA_BODY_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(source, maxBytes));
}
