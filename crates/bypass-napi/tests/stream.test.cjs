// Build first: cargo build -p bypass-napi
// Run: BYPASS_NAPI_LIBRARY=target/debug/libbypass_napi.so node --test crates/bypass-napi/tests/stream.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const addon = { exports: {} };
process.dlopen(addon, path.resolve(process.env.BYPASS_NAPI_LIBRARY || 'target/debug/libbypass_napi.so'));

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('close interrupts a pending native receive and closes upstream', { timeout: 5000 }, async () => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  await serve((request, response) => {
    request.socket.on('close', upstreamClosed);
    response.writeHead(200, { 'content-length': '100' });
    response.write('part');
  }, async (url) => {
    const stream = await addon.exports.bypassFetch(url);
    assert.equal((await stream.read()).toString(), 'part');
    const pending = stream.read();
    // Give read a chance to hold the receiver lock while the server stalls.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.close();
    assert.equal(await pending, null);
    assert.equal(await stream.read(), null);
    await closed;
  });
});

test('native body truncation rejects read instead of returning clean EOF', { timeout: 5000 }, async () => {
  await serve((_request, response) => {
    response.writeHead(200, { 'content-length': '100', connection: 'close' });
    response.write('part');
    response.end();
  }, async (url) => {
    const stream = await addon.exports.bypassFetch(url);
    await assert.rejects(async () => {
      while (await stream.read() !== null) { /* consume until terminal result */ }
    }, /body|read|length|message/i);
    stream.close();
  });
});


test('a malformed response head is not replayed and a later request succeeds', { timeout: 5000 }, async () => {
  let failedRequests = 0;
  let healthyRequests = 0;
  await serve((request, response) => {
    if (request.url === '/broken') {
      failedRequests += 1;
      // An invalid response head is a deterministic terminal parse error, not
      // an idle pooled-socket closure that the HTTP client may safely retry.
      request.socket.end('INVALID HTTP RESPONSE\r\n\r\n');
      return;
    }
    healthyRequests += 1;
    response.writeHead(200, { 'x-fixture': 'healthy' });
    response.end('still usable');
  }, async (url) => {
    await assert.rejects(addon.exports.bypassFetch(`${url}broken`), /request|http|message/i);
    assert.equal(failedRequests, 1, 'the binding must not repeat a failed core request');
    const stream = await addon.exports.bypassFetch(`${url}healthy`);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['x-fixture'], 'healthy');
    const chunks = [];
    let chunk;
    while ((chunk = await stream.read()) !== null) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'still usable');
    assert.equal(await stream.read(), null);
    stream.close();
    assert.equal(healthyRequests, 1);
    assert.equal(failedRequests, 1);
  });
});

test('a normal HTTP 404 remains a response with its headers and body', { timeout: 5000 }, async () => {
  let requests = 0;
  await serve((_request, response) => {
    requests += 1;
    response.writeHead(404, { 'x-fixture': 'missing' });
    response.end('not found');
  }, async (url) => {
    const stream = await addon.exports.bypassFetch(url);
    assert.equal(stream.status, 404);
    assert.equal(stream.headers['x-fixture'], 'missing');
    const chunks = [];
    let chunk;
    while ((chunk = await stream.read()) !== null) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'not found');
    assert.equal(await stream.read(), null);
    stream.close();
    assert.equal(requests, 1);
  });
});
