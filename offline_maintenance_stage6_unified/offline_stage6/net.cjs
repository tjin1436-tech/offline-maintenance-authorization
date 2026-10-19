'use strict';
const http = require('node:http');
const {performance} = require('node:perf_hooks');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, msg) => { if (!ok) throw Error(msg); };
async function request(url, body, timeout = 3000) {
  const start = performance.now(), ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {method: body === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: ac.signal});
    return {status: r.status, body: await r.json(), duration_ms: performance.now() - start};
  } catch (e) { return {status: 0, body: {error: e.name}, duration_ms: performance.now() - start}; }
  finally { clearTimeout(timer); }
}
async function serve(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      let data = ''; for await (const c of req) { data += c; if (data.length > 4000000) throw Error('body too large'); }
      const r = await handler(req.url, data ? JSON.parse(data) : undefined);
      if (r.drop) { res.destroy(); return; }
      if (!res.destroyed) { res.writeHead(r.status || 200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(r.body)); }
    } catch (e) { if (!res.destroyed) { res.writeHead(500); res.end(JSON.stringify({error: String(e)})); } }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); })};
}
function serial() {
  let tail = Promise.resolve();
  return fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
}
module.exports = {request, serve, sleep, assert, serial, performance};
