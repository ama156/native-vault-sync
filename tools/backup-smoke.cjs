"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process"),
  net = require("node:net"),
  crypto = require("node:crypto");
const { once } = require("node:events"),
  assert = require("node:assert/strict");
const { WebSocket } = require("ws");
async function main() {
  const binary = process.env.SYNC_TEST_BINARY,
    restic = process.env.SYNC_TEST_RESTIC;
  for (const p of [binary, restic])
    if (!p || !path.isAbsolute(p) || p.startsWith("/Applications/"))
      throw Error("Supply absolute sandbox server/restic binaries");
  const root = fs.mkdtempSync("/tmp/vs-backup-"),
    config = path.join(root, "config.json"),
    data = path.join(root, "data");
  const password = crypto.randomBytes(24).toString("hex"),
    repoPassword = path.join(root, "restic-password");
  fs.writeFileSync(
    repoPassword,
    crypto.randomBytes(32).toString("hex") + "\n",
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    RESTIC_REPOSITORY: path.join(root, "repository"),
    RESTIC_PASSWORD_FILE: repoPassword,
    RESTIC_CACHE_DIR: path.join(root, "cache"),
  };
  const run = (file, args, input) => {
    const r = cp.spawnSync(file, args, {
      input,
      encoding: "utf8",
      env,
      maxBuffer: 16 << 20,
    });
    if (r.status !== 0)
      throw Error(path.basename(file) + " failed: " + r.stderr.slice(0, 200));
    return r.stdout;
  };
  let child, socket;
  const checks = [];
  try {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((r) => listener.close(r));
    const origin = "http://127.0.0.1:" + port;
    run(
      binary,
      [
        "init",
        "--config",
        config,
        "--data-dir",
        data,
        "--listen",
        "127.0.0.1:" + port,
        "--public-url",
        origin,
        "--email",
        "backup@local.invalid",
        "--password-stdin",
      ],
      password + "\n",
    );
    async function start(file) {
      child = cp.spawn(binary, ["serve", "--config", file], {
        stdio: ["ignore", "ignore", "pipe"],
        env,
      });
      await new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(Error("Server startup timed out")),
          10000,
        );
        child.stderr.on("data", (d) => {
          if (d.toString().includes("server ready")) {
            clearTimeout(t);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(t);
          reject(Error("Test server exited"));
        });
      });
    }
    async function stop() {
      if (child && child.exitCode === null) {
        const p = once(child, "exit");
        child.kill("SIGTERM");
        await p;
      }
      child = null;
    }
    async function post(route, body) {
      const r = await fetch(origin + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
      const x = await r.json();
      if (!r.ok || x.error) throw Error("Test API failed: " + route);
      return x;
    }
    await start(config);
    const account = await post("/user/signin", {
      email: "backup@local.invalid",
      password,
    });
    const vault = await post("/vault/create", {
      token: account.token,
      name: "Disposable backup test",
      salt: "synthetic",
      keyhash: "synthetic",
      encryption_version: 3,
    });
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/sync");
    socket = ws;
    const messages = [],
      waiters = [];
    ws.on("message", (d, b) => {
      const value = b ? d : JSON.parse(d.toString());
      if (waiters.length) waiters.shift()(value);
      else messages.push(value);
    });
    const next = () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : Promise.race([
            new Promise((r) => waiters.push(r)),
            new Promise((_, reject) => {
              const t = setTimeout(
                () => reject(Error("Socket timeout")),
                10000,
              );
              t.unref();
            }),
          ]);
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        op: "init",
        token: account.token,
        id: vault.id,
        keyhash: "synthetic",
        encryption_version: 3,
        initial: true,
      }),
    );
    assert.equal((await next()).res, "ok");
    assert.equal((await next()).op, "ready");
    const ciphertext = crypto.randomBytes(2097152 + 31);
    ws.send(
      JSON.stringify({
        op: "push",
        path: "opaque-path",
        hash: "opaque-hash",
        extension: "png",
        ctime: 1,
        mtime: 1,
        size: ciphertext.length,
        pieces: 2,
      }),
    );
    assert.equal((await next()).res, "upload");
    for (let i = 0; i < ciphertext.length; i += 2097152) {
      ws.send(ciphertext.subarray(i, i + 2097152));
      let ack;
      do {
        ack = await next();
      } while (ack.op);
      assert.equal(ack.res, "ok");
    }
    ws.close();
    socket = null;
    run(
      binary,
      [
        "users",
        "add",
        "--config",
        config,
        "--email",
        "coowner@local.invalid",
        "--name",
        "Co-owner",
        "--password-stdin",
      ],
      password + "\n",
    );
    run(binary, [
      "vaults",
      "grant",
      "--config",
      config,
      "--user",
      "coowner@local.invalid",
      "--vault",
      vault.id,
    ]);
    const second = await post("/user/signin", {
      email: "coowner@local.invalid",
      password,
    });
    assert.equal(
      (await post("/vault/list", { token: second.token })).vaults.length,
      1,
    );
    checks.push(
      "Live Unix administration creates a user and co-owner without public administration endpoints",
    );
    await stop();
    const snapshot = path.join(root, "snapshot");
    run(binary, [
      "backup",
      "--config",
      config,
      "--format",
      "directory",
      "--output",
      snapshot,
    ]);
    checks.push(
      "Consistent directory snapshot includes users, membership and multipart ciphertext",
    );
    run(restic, ["init"]);
    run(restic, ["backup", snapshot, "--tag", "vault-sync"]);
    run(restic, ["check", "--read-data"]);
    const first = JSON.parse(run(restic, ["snapshots", "--json"]))[0].id;
    run(restic, ["backup", snapshot, "--tag", "vault-sync"]);
    const restoredFiles = path.join(root, "restic-restored");
    run(restic, ["restore", first, "--target", restoredFiles]);
    const restoredSnapshot = path.join(
      restoredFiles,
      snapshot.replace(/^\//, ""),
    );
    assert.ok(fs.existsSync(path.join(restoredSnapshot, "manifest.json")));
    checks.push(
      "Official restic creates repeated snapshots, verifies repository data, and restores the unpacked snapshot",
    );
    const restoredConfig = path.join(root, "restored-config.json"),
      restoredData = path.join(root, "restored-data");
    run(binary, [
      "restore",
      "--snapshot",
      restoredSnapshot,
      "--config",
      restoredConfig,
      "--data-dir",
      restoredData,
    ]);
    await start(restoredConfig);
    assert.equal(
      (await post("/user/info", { token: second.token })).email,
      "coowner@local.invalid",
    );
    assert.equal(
      (await post("/vault/list", { token: second.token })).vaults[0].id,
      vault.id,
    );
    const blobs = fs.readdirSync(path.join(restoredData, "blobs", vault.id));
    assert.deepEqual(
      fs.readFileSync(path.join(restoredData, "blobs", vault.id, blobs[0])),
      ciphertext,
    );
    checks.push(
      "Fresh server restoration preserves co-owner sessions, vault identity and exact >2 MiB ciphertext",
    );
    return {
      status: "passed",
      serverVersion: "0.2.0",
      resticVersion: run(restic, ["version"]).trim().split(/\s+/)[1],
      checks,
      limits: [
        "Disposable loopback server and encrypted synthetic bytes; no installed app or real data used.",
      ],
    };
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null) {
      const p = once(child, "exit");
      child.kill("SIGTERM");
      await p;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main()
  .then((r) => {
    const text = JSON.stringify(r, null, 2) + "\n";
    if (process.env.SYNC_BACKUP_TEST_REPORT)
      fs.writeFileSync(process.env.SYNC_BACKUP_TEST_REPORT, text);
    process.stdout.write(text);
  })
  .catch((e) => {
    process.stderr.write(e.message + "\n");
    process.exitCode = 1;
  });
