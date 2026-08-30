import type { MockApp } from '../app.js';
import { Errors } from '../errors.js';
import { attachPendingVault } from '../services/sessions.js';
import { tokenizeCard } from '../services/tokenize.js';
import { assertNoSensitiveMaterial } from '../domain/sensitive.js';

const ENROLLMENT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Yuno mock — test enrollment</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-top: 0.75rem; font-size: 0.9rem; }
    input { width: 100%; padding: 0.4rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; }
    pre { background: #f4f4f5; padding: 0.75rem; overflow: auto; }
    .hint { color: #52525b; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Test enrollment</h1>
  <p class="hint">Dev/test only. Fictional PAN/CVV never leave this mock; discarded after tokenization.</p>
  <form id="f">
    <label>customer_session <input name="customer_session" required /></label>
    <label>PAN <input name="pan" inputmode="numeric" autocomplete="off" required /></label>
    <label>CVV <input name="cvv" inputmode="numeric" autocomplete="off" required /></label>
    <label>Expiration month <input name="expiration_month" type="number" min="1" max="12" required /></label>
    <label>Expiration year <input name="expiration_year" type="number" min="0" required /></label>
    <button type="submit">Tokenize</button>
  </form>
  <pre id="out"></pre>
  <script>
    const form = document.getElementById('f');
    const out = document.getElementById('out');
    const params = new URLSearchParams(location.search);
    if (params.get('customer_session')) {
      form.customer_session.value = params.get('customer_session');
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        customer_session: form.customer_session.value,
        pan: form.pan.value,
        cvv: form.cvv.value,
        expiration_month: Number(form.expiration_month.value),
        expiration_year: Number(form.expiration_year.value),
      };
      form.pan.value = '';
      form.cvv.value = '';
      const res = await fetch('/test/enrollment/tokenize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      out.textContent = JSON.stringify(json, null, 2);
    });
  </script>
</body>
</html>`;

export function registerTestEnrollmentRoutes(app: MockApp): void {
  app.get('/test/enrollment', (c) => {
    const config = c.get('config');
    if (config.NODE_ENV === 'production') {
      throw Errors.notFound('Not found');
    }
    return c.html(ENROLLMENT_HTML);
  });

  app.post('/test/enrollment/tokenize', async (c) => {
    const config = c.get('config');
    if (config.NODE_ENV === 'production') {
      throw Errors.notFound('Not found');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw Errors.invalidJson();
    }

    const customerSession = String(body.customer_session ?? '');
    const pan = String(body.pan ?? '');
    const cvv = String(body.cvv ?? '');
    const expirationMonth = Number(body.expiration_month);
    const expirationYear = Number(body.expiration_year);

    if (!customerSession) {
      throw Errors.invalidRequest('customer_session is required');
    }

    let tokenized;
    try {
      tokenized = tokenizeCard({
        pan,
        cvv,
        expirationMonth,
        expirationYear,
        fingerprintSecret: config.YUNO_MOCK_FINGERPRINT_SECRET,
      });
    } catch (err) {
      throw Errors.invalidRequest(err instanceof Error ? err.message : 'tokenization failed');
    }

    // Discard raw card material from local scope before persistence.
    body.pan = undefined;
    body.cvv = undefined;

    await attachPendingVault(c.get('repo'), customerSession, tokenized);

    const response = {
      customer_session: customerSession,
      vaulted_token: tokenized.vaulted_token,
      fingerprint: tokenized.fingerprint,
      brand: tokenized.brand,
      last4: tokenized.last4,
      expiration_month: tokenized.expiration_month,
      expiration_year: tokenized.expiration_year,
    };

    assertNoSensitiveMaterial(response, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
    ]);

    return c.json(response, 201);
  });
}
