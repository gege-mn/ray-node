// Smoke-tests the built package (dist/) through both the ESM and CJS entry
// points, without network access. Runs on Node 18+ (CI also runs it on 18,
// where Web Crypto comes from the node:crypto fallback).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esm = await import('../dist/index.js');
const cjs = require('../dist/index.cjs');

for (const [label, sdk] of [
  ['esm', esm],
  ['cjs', cjs],
]) {
  const secret = 'smoke-secret';
  const body = '{"event":"send.completed","send_id":"s"}';
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  assert.equal(
    await sdk.verifyWebhookSignature({
      payload: body,
      headers: { 'x-ray-signature': header },
      secret,
    }),
    true,
    `${label}: valid signature`,
  );
  assert.equal(
    await sdk.verifyWebhookSignature({
      payload: `${body} `,
      headers: { 'x-ray-signature': header },
      secret,
    }),
    false,
    `${label}: tampered body`,
  );
  const event = await sdk.parseWebhookEvent({
    payload: body,
    headers: { 'x-ray-signature': header },
    secret,
  });
  assert.equal(event.send_id, 's');

  let seen;
  const ray = new sdk.Ray('ck_live_smoke', {
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ sendId: 'abc' }), { status: 202 });
    },
  });
  assert.deepEqual(await ray.send({ externalUserId: 'u', feed: { title: 't' } }), {
    sendId: 'abc',
  });
  assert.equal(seen.url, 'https://ray-api.gege.mn/send');
  assert.match(seen.init.headers['idempotency-key'], /^[0-9a-f-]{36}$/);
  assert.equal(seen.init.headers.authorization, 'Bearer ck_live_smoke');

  const failing = new sdk.Ray('ck_live_smoke', {
    maxRetries: 0,
    fetch: async () =>
      new Response(JSON.stringify({ error: 'not_found', message: 'send not found' }), {
        status: 404,
        headers: { 'x-request-id': 'req_1' },
      }),
  });
  await assert.rejects(failing.sends.get('missing'), (err) => {
    assert.ok(err instanceof sdk.RayError);
    assert.equal(err.code, 'not_found');
    assert.equal(err.requestId, 'req_1');
    return true;
  });
  console.log(`${label}: ok (${sdk.VERSION}, node ${process.version})`);
}
