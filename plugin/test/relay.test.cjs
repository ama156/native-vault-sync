const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const { Relay, validateServer, CHUNK } = require("../src/relay.cjs");
test("only HTTPS origins and explicit local development origins are accepted", () => {
  assert.equal(
    validateServer("https://vault.example.com/"),
    "https://vault.example.com",
  );
  assert.equal(
    validateServer("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  );
  for (const url of [
    "http://vault.example.com",
    "https://user:password@vault.example.com",
    "https://vault.example.com/path",
    "https://vault.example.com/?token=private",
    "https://vault.example.com/#secret",
    "file:///tmp/test",
  ])
    assert.throws(() => validateServer(url));
});
test("relay preserves text/binary message boundaries and closes without a separate process", async (t) => {
  const server = http.createServer();
  const upstream = new WebSocketServer({ server, maxPayload: CHUNK });
  const received = [];
  upstream.on("connection", (ws) =>
    ws.on("message", (data, binary) => {
      received.push({ data: Buffer.from(data), binary });
      ws.send(data, { binary });
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const relay = new Relay("http://127.0.0.1:" + server.address().port);
  await relay.start();
  t.after(async () => {
    await relay.stop();
    for (const client of upstream.clients) client.terminate();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => server.close(r));
  });
  const client = new WebSocket(relay.url);
  await once(client, "open");
  const messages = [];
  client.on("message", (data, binary) =>
    messages.push({ data: Buffer.from(data), binary }),
  );
  const a = Buffer.alloc(CHUNK, 7),
    b = Buffer.from([0, 255, 1, 2]);
  client.send('{"op":"init","token":"fixture"}');
  client.send(a);
  client.send(b);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Relay did not preserve messages")),
      3000,
    );
    const check = setInterval(() => {
      if (messages.length === 3) {
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  assert.equal(received[0].binary, false);
  assert.equal(messages[0].binary, false);
  assert.equal(messages[1].binary, true);
  assert.deepEqual(messages[1].data, a);
  assert.deepEqual(messages[2].data, b);
  assert.equal(received.length, 3);
  const closed = once(client, "close");
  await relay.stop();
  await closed;
});
test("wrong capability cannot reach the upstream", async () => {
  const relay = new Relay("http://127.0.0.1:1");
  await relay.start();
  const invalid = new WebSocket(relay.url.replace(relay.path, "/wrong"));
  await new Promise((resolve) => {
    invalid.on("error", resolve);
    invalid.on("open", () => assert.fail("Capability bypass"));
  });
  assert.equal(relay.pairs.size, 0);
  await relay.stop();
});
