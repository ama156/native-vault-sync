"use strict";
// Disposable black-box CLI/storage test. Never uses an installed application.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  net = require("node:net"),
  crypto = require("node:crypto"),
  cp = require("node:child_process"),
  { once } = require("node:events"),
  { WebSocket } = require("ws"),
  assert = require("node:assert/strict");
const binary = process.env.SYNC_TEST_BINARY;
if (!binary || !path.isAbsolute(binary) || binary.startsWith("/Applications/"))
  throw Error("Set SYNC_TEST_BINARY to the built test executable.");
const root = fs.mkdtempSync(
  path.join(process.env.SYNC_TEST_TMPDIR || os.tmpdir(), "vault-sync-crash-"),
);
const config = path.join(root, "config.json"),
  dataDir = path.join(root, "data"),
  password = crypto.randomBytes(24).toString("hex");
let child;
function cli(args, input) {
  const r = cp.spawnSync(binary, args, { input, encoding: "utf8" });
  if (r.status !== 0) throw Error(r.stderr || "CLI failed");
  return r.stdout;
}
async function port() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function start(file) {
  child = cp.spawn(binary, ["serve", "--config", file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const process = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Test server did not become ready")),
      15000,
    );
    let text = "";
    process.stderr.on("data", (b) => {
      text += b.toString();
      if (text.includes("server ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    process.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Test server exited " + code));
    });
  });
  return process;
}
async function stop(signal = "SIGTERM") {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  }
  child = null;
}
async function post(base, route, body) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok || result.error) throw Error(result.error || "HTTP failure");
  return result;
}
async function connection(base, token, vault) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/sync"),
    queue = [],
    waiters = [];
  socket.on("error", () => {});
  socket.on("message", (data, binary) => {
    const item = binary ? Buffer.from(data) : JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(item);
    else queue.push(item);
  });
  await once(socket, "open");
  const read = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("WebSocket response timeout")),
            10000,
          );
          waiters.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
  const response = async () => {
    for (;;) {
      const m = await read();
      if (m.res) return m;
    }
  };
  const send = (m) => socket.send(JSON.stringify(m));
  send({
    op: "init",
    token,
    id: vault.id,
    keyhash: vault.keyhash,
    version: 0,
    initial: false,
    encryption_version: 3,
    device: "crash fixture",
  });
  assert.equal((await response()).res, "ok");
  let ready;
  const replay = [];
  for (;;) {
    const m = await read();
    if (m.op === "ready") {
      ready = m;
      break;
    }
    replay.push(m);
  }
  return { socket, read, response, send, replay, ready };
}
(async () => {
  const p = await port(),
    base = "http://127.0.0.1:" + p;
  cli(
    [
      "init",
      "--config",
      config,
      "--data-dir",
      dataDir,
      "--public-url",
      base,
      "--email",
      "crash@local.invalid",
      "--password-stdin",
    ],
    password + "\n",
  );
  const cfg = JSON.parse(fs.readFileSync(config));
  cfg.listen = "127.0.0.1:" + p;
  fs.writeFileSync(config, JSON.stringify(cfg));
  await start(config);
  const account = await post(base, "/user/signin", {
    email: "crash@local.invalid",
    password,
  });
  const vault = await post(base, "/vault/create", {
    token: account.token,
    name: "Crash fixture",
    salt: "fixture-salt",
    keyhash: "opaque-fixture-keyhash",
    encryption_version: 3,
  });
  vault.keyhash = "opaque-fixture-keyhash";
  const a = await connection(base, account.token, vault);
  const bytes = crypto.randomBytes(4096);
  a.send({
    op: "push",
    path: "aabb",
    hash: "ccdd",
    size: bytes.length,
    pieces: 1,
  });
  assert.equal((await a.response()).res, "upload");
  a.socket.send(bytes);
  assert.equal((await a.response()).res, "ok");
  a.send({ op: "push", path: "eeff", hash: "1122", size: 2097155, pieces: 2 });
  assert.equal((await a.response()).res, "upload");
  a.socket.send(Buffer.alloc(2097152, 17));
  assert.equal((await a.response()).res, "ok");
  await stop("SIGKILL");
  a.socket.terminate();
  await start(config);
  const b = await connection(base, account.token, vault);
  assert.equal(b.ready.version, 1);
  assert.equal(b.replay.length, 1);
  assert.equal(b.replay[0].path, "aabb");
  b.send({ op: "pull", uid: 1 });
  assert.equal((await b.response()).pieces, 1);
  assert.deepEqual(await b.read(), bytes);
  assert.equal(fs.readdirSync(path.join(dataDir, "uploads")).length, 0);
  b.socket.terminate();
  await stop();
  const archive = path.join(root, "backup.tar.gz");
  cli(["backup", "--config", config, "--output", archive]);
  const restoredConfig = path.join(root, "restored.json"),
    restoredData = path.join(root, "restored");
  cli([
    "restore",
    "--archive",
    archive,
    "--config",
    restoredConfig,
    "--data-dir",
    restoredData,
  ]);
  await start(restoredConfig);
  const c = await connection(base, account.token, vault);
  c.send({ op: "pull", uid: 1 });
  await c.response();
  assert.deepEqual(await c.read(), bytes);
  c.socket.terminate();
  await stop();
  const result = {
    status: "passed",
    platform: process.platform,
    mode: "separate server subprocesses and real loopback sockets",
    checks: [
      "acknowledged revision survives SIGKILL",
      "partial upload never committed",
      "abandoned upload removed on startup",
      "session persists across restart",
      "offline backup and restore into a fresh server preserve ciphertext",
    ],
    at: new Date().toISOString(),
  };
  if (process.env.SYNC_TEST_REPORT)
    fs.writeFileSync(
      process.env.SYNC_TEST_REPORT,
      JSON.stringify(result, null, 2),
    );
  console.log(JSON.stringify(result, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
})().catch(async (error) => {
  await stop();
  console.error(error);
  console.error("Disposable failure directory retained: " + root);
  process.exitCode = 1;
});
