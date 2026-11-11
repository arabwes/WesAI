// Guards the booking-link rewrite. Cloudflare Pages strips ".html" from addresses, so a
// "200" rewrite whose destination ends in .html is answered with a 308 redirect to the
// clean address instead of serving the page. For /book/<token> that redirect drops the
// private token, so every booking link would open an empty page. This happened in
// production once; destinations must be clean (extensionless) paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const rules = readFileSync(new URL('_redirects', root), 'utf8').split('\n')
  .map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => line.split(/\s+/));

test('200 rewrites point at clean paths, never at .html files', () => {
  const rewrites = rules.filter((parts) => parts[2] === '200');
  assert.ok(rewrites.length >= 1, 'the booking rewrite exists');
  for (const [from, to] of rewrites) {
    assert.ok(!to.endsWith('.html'), `${from} -> ${to}: Pages would answer 308 and the booking token would be lost`);
  }
});

test('the booking rewrite covers both link shapes and its page exists', () => {
  const booking = rules.find((parts) => parts[0] === '/book/*');
  assert.ok(booking, '/book/* rule exists (covers /book/<token> and /book/manage/<token>)');
  assert.equal(booking[1], '/book');
  assert.ok(existsSync(new URL('book.html', root)), '/book is served from book.html');
});

test('the catering conversation rewrite covers /inquiry/<token> and its page exists', () => {
  const inquiry = rules.find((parts) => parts[0] === '/inquiry/*');
  assert.ok(inquiry, '/inquiry/* rule exists');
  assert.equal(inquiry[1], '/inquiry');
  assert.equal(inquiry[2], '200');
  assert.ok(existsSync(new URL('inquiry.html', root)), '/inquiry is served from inquiry.html');
});

test('pages that carry a private token are kept out of search, caches and referrers', () => {
  const headers = readFileSync(new URL('_headers', root), 'utf8');
  for (const prefix of ['/book/*', '/inquiry/*']) {
    const block = headers.slice(headers.indexOf(`\n${prefix}\n`)).split('\n\n')[0];
    assert.match(block, /Cache-Control: no-store/, prefix);
    assert.match(block, /X-Robots-Tag: noindex/, prefix);
    assert.match(block, /Referrer-Policy: no-referrer/, prefix);
  }
  const robots = readFileSync(new URL('robots.txt', root), 'utf8');
  assert.match(robots, /Disallow: \/book\//);
  assert.match(robots, /Disallow: \/inquiry\//);
});
