#!/usr/bin/env node
// Local dev server that behaves like Cloudflare Pages.
//
// Use this instead of `python3 -m http.server`. Pages does two things a
// plain static server does not, and both have already caused real bugs
// that local testing missed:
//
//   1. It strips ".html": /team/dashboard.html 308-redirects to
//      /team/dashboard, and /team/dashboard serves team/dashboard.html.
//      Code that links to .html URLs therefore takes an extra redirect on
//      every navigation in production but none locally.
//   2. It applies the rules in _headers, including the no-cache policy
//      that keeps /team/* from being pinned to a stale copy.
//
// Testing against a server that lacks these hides that whole class of
// problem until it reaches real browsers.
//
//   node dev-server.cjs [port]        # default 8000
//   http://localhost:8000/team/

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8'
};

// Minimal _headers parser: "/path/*" followed by indented "Name: value".
function loadHeaderRules() {
  const file = path.join(ROOT, '_headers');
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

const HEADER_RULES = loadHeaderRules();

function headersFor(pathname) {
  const out = {};
  for (const rule of HEADER_RULES) {
    const re = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (re.test(pathname)) Object.assign(out, rule.headers);
  }
  return out;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  // Pages strips the .html extension with a permanent redirect.
  if (pathname.endsWith('.html') && !pathname.endsWith('/index.html')) {
    res.writeHead(308, { Location: pathname.slice(0, -5) + url.search });
    res.end();
    return;
  }

  let file = pathname.endsWith('/')
    ? path.join(ROOT, pathname, 'index.html')
    : path.join(ROOT, pathname);

  // Extensionless request -> the .html file behind it.
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';

  // Block traversal outside the site root.
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found: ' + pathname);
    return;
  }

  res.writeHead(200, Object.assign(
    { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' },
    headersFor(pathname)
  ));
  res.end(fs.readFileSync(file));
}).listen(PORT, () => {
  console.log('Serving ' + ROOT);
  console.log('  http://localhost:' + PORT + '/');
  console.log('  http://localhost:' + PORT + '/team/');
  console.log('Mimicking Cloudflare Pages: .html stripping + _headers rules');
});
