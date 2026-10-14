import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../functions/_lib/http.js';
import { submitCateringRequest } from '../functions/_lib/catering.js';
import { onRequestPost as postContact } from '../functions/api/contact-request.js';

test('JSON body limit applies when Content-Length is absent', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: 'x'.repeat(1_000_000) })));
      controller.close();
    }
  });
  const request = new Request('https://example.test/api/team', { method: 'POST', body, duplex: 'half' });
  await assert.rejects(readJson(request), (error) => error.code === 'payload_too_large' && error.status === 413);
});

test('catering request needs event details', async () => {
  await assert.rejects(
    submitCateringRequest(null, {
      name: 'Customer', email: 'customer@example.com', phone: '4705550100', eventType: 'Wedding', details: ' '
    }, {}),
    (error) => error.code === 'missing_details'
  );
});

test('contact endpoint validates and persists a message', async () => {
  const inserts = [];
  const env = { TEAM_DB: {
    prepare(sql) {
      assert.match(sql, /INSERT INTO contact_requests/);
      return { bind(...values) { return { async run() { inserts.push(values); } }; } };
    }
  } };
  const data = new FormData();
  data.set('name', 'A Customer');
  data.set('email', 'customer@example.com');
  data.set('message', 'Can you help with an order?');
  const request = new Request('https://example.test/api/contact-request', { method: 'POST', body: data });
  const response = await postContact({ request, env });
  assert.equal(response.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][1], 'A Customer');
  assert.equal(inserts[0][2], 'customer@example.com');
  assert.equal(inserts[0][4], 'Can you help with an order?');
});
