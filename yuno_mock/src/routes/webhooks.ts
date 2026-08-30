import type { MockApp } from '../app.js';
import { Errors } from '../errors.js';
import {
  headerMapFromHono,
  requireValidRequest,
  requireValidResponse,
} from '../contract.js';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  updateWebhook,
  type WebhookCreateBody,
  type WebhookUpdateBody,
} from '../services/webhooks.js';
import { assertNoSensitiveMaterial } from '../domain/sensitive.js';

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw Errors.invalidJson();
  }
}

export function registerWebhookRoutes(app: MockApp): void {
  app.post('/v1/webhooks', async (c) => {
    const headers = headerMapFromHono(c);
    const body = (await readJsonBody(c)) as WebhookCreateBody;
    requireValidRequest('create-webhook', body, headers);

    const config = c.get('config');
    const result = await createWebhook(c.get('repo'), body, config.secretsKey);
    requireValidResponse('create-webhook', 201, result);
    assertNoSensitiveMaterial(result, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
      ...(typeof body.hmac_client_secret === 'string' ? [body.hmac_client_secret] : []),
      ...(typeof body.api_key === 'string' ? [body.api_key] : []),
      ...(typeof body.secret === 'string' ? [body.secret] : []),
      ...(typeof body.oauth2_client_secret === 'string' ? [body.oauth2_client_secret] : []),
    ]);
    return c.json(result, 201);
  });

  app.get('/v1/webhooks', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('list-webhooks', undefined, headers);
    const config = c.get('config');
    const result = await listWebhooks(c.get('repo'));
    requireValidResponse('list-webhooks', 200, result);
    assertNoSensitiveMaterial(result, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
    ]);
    return c.json(result, 200);
  });

  app.patch('/v1/webhooks/:webhook_id', async (c) => {
    const headers = headerMapFromHono(c);
    const body = (await readJsonBody(c)) as WebhookUpdateBody;
    requireValidRequest('update-webhook', body, headers);
    const webhookId = c.req.param('webhook_id');
    const config = c.get('config');
    const result = await updateWebhook(
      c.get('repo'),
      webhookId,
      body,
      config.secretsKey,
    );
    requireValidResponse('update-webhook', 200, result);
    assertNoSensitiveMaterial(result, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
      ...(typeof body.hmac_client_secret === 'string' ? [body.hmac_client_secret] : []),
      ...(typeof body.api_key === 'string' ? [body.api_key] : []),
      ...(typeof body.secret === 'string' ? [body.secret] : []),
      ...(typeof body.oauth2_client_secret === 'string' ? [body.oauth2_client_secret] : []),
    ]);
    return c.json(result, 200);
  });

  app.delete('/v1/webhooks/:webhook_id', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('delete-webhook', undefined, headers);
    const webhookId = c.req.param('webhook_id');
    const config = c.get('config');
    const result = await deleteWebhook(c.get('repo'), webhookId);
    requireValidResponse('delete-webhook', 200, result);
    assertNoSensitiveMaterial(result, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
    ]);
    return c.json(result, 200);
  });
}
