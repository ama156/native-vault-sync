"use strict";
// Black-box packaging tests. Requires a locally built image and Docker Engine.
// Uses only random test projects/volumes, no app resources or real vaults.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");

const root = path.resolve(__dirname, "..");
const image = process.env.SYNC_CONTAINER_IMAGE || "native-vault-sync:ci";
const prefix = "vault-sync-test-" + crypto.randomBytes(6).toString("hex");
const restored = prefix + "-restored";
const backupContainer = prefix + "-backup";
const plainContainer = prefix + "-plain";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix + "-"));
const password = crypto.randomBytes(24).toString("hex");
const env = { ...process.env, VAULT_SYNC_IMAGE: image, VAULT_SYNC_PORT: "0" };
const checks = [];
function docker(args, { input, allowedFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!allowedFailure && result.status !== 0) {
    throw Error(
      "Docker command failed: " +
        (result.stderr || result.error || result.status),
    );
  }
  return result;
}
function compose(project, args, options) {
  return docker(
    ["compose", "--project-name", project, "--file", "compose.yaml", ...args],
    options,
  );
}
function record(check) {
  checks.push(check);
  console.log("PASS " + check);
}
function address(project) {
  return (
    "http://" + compose(project, ["port", "vault-sync", "8080"]).stdout.trim()
  );
}
async function waitReady(base) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(base + "/healthz", {
        signal: AbortSignal.timeout(1000),
      });
      const body = await response.json();
      if (response.ok && body.ready === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error("Container did not become ready");
}
async function post(base, route, body) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  assert.equal(response.ok, true);
  if (result.error) throw Error("Fixture account operation failed");
  return result;
}
async function connection(base, token, vault) {
  const socket = new WebSocket(base.replace(/^http/, "ws") + "/sync");
  const queue = [],
    readers = [];
  socket.on("error", () => {});
  socket.on("message", (bytes, binary) => {
    const value = binary ? Buffer.from(bytes) : JSON.parse(bytes.toString());
    const reader = readers.shift();
    if (reader) reader(value);
    else queue.push(value);
  });
  await Promise.race([
    once(socket, "open"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("WebSocket open timeout")),
        15000,
      );
      timer.unref();
    }),
  ]);
  const read = () =>
    queue.length
      ? Promise.resolve(queue.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("WebSocket message timeout")),
            15000,
          );
          readers.push((value) => {
            clearTimeout(timer);
            resolve(value);
          });
        });
  const response = async () => {
    for (;;) {
      const value = await read();
      if (value.res) return value;
    }
  };
  const send = (value) => socket.send(JSON.stringify(value));
  send({
    op: "init",
    token,
    id: vault.id,
    keyhash: vault.keyhash,
    encryption_version: 3,
    initial: false,
    version: 0,
    device: "container fixture",
  });
  assert.equal((await response()).res, "ok");
  const replay = [];
  for (;;) {
    const value = await read();
    if (value.op === "ready") break;
    replay.push(value);
  }
  return { socket, read, response, send, replay };
}
async function pull(base, token, vault, uid, expected) {
  const client = await connection(base, token, vault);
  try {
    assert(client.replay.some((item) => item.uid === uid));
    client.send({ op: "pull", uid });
    const meta = await client.response();
    assert.equal(meta.res, "ok");
    assert.equal(meta.size, expected.length);
    const parts = [];
    for (let piece = 0; piece < meta.pieces; piece++) {
      const bytes = await client.read();
      assert(Buffer.isBuffer(bytes));
      parts.push(bytes);
    }
    assert.deepEqual(Buffer.concat(parts), expected);
  } finally {
    client.socket.terminate();
  }
}

(async () => {
  try {
    const inspected = JSON.parse(docker(["image", "inspect", image]).stdout)[0];
    assert.equal(inspected.Config.User, "10001:10001");
    assert.deepEqual(inspected.Config.Entrypoint, [
      "/usr/local/bin/vault-sync-server",
    ]);
    assert.equal(
      docker(["run", "--rm", "--read-only", image, "version"]).stdout.trim(),
      "0.2.0",
    );
    record("non-root image and executable entrypoint");

    compose(
      prefix,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "vault-sync",
        "init",
        "--listen",
        "0.0.0.0:8080",
        "--public-url",
        "https://container-test.invalid",
        "--email",
        "container@local.invalid",
        "--password-stdin",
      ],
      { input: password + "\n" },
    );
    compose(prefix, [
      "up",
      "--detach",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "90",
    ]);
    let base = address(prefix);
    await waitReady(base);
    const id = compose(prefix, ["ps", "--quiet", "vault-sync"]).stdout.trim();
    const container = JSON.parse(docker(["inspect", id]).stdout)[0];
    assert.equal(container.State.Health.Status, "healthy");
    assert.equal(container.HostConfig.ReadonlyRootfs, true);
    assert(container.HostConfig.CapDrop.includes("ALL"));
    assert(
      container.HostConfig.SecurityOpt.some((x) =>
        x.startsWith("no-new-privileges"),
      ),
    );
    compose(prefix, [
      "exec",
      "-T",
      "vault-sync",
      "/usr/local/bin/vault-sync-server",
      "status",
    ]);
    record(
      "Compose initialization, writable named volumes, health check and read-only root",
    );

    const account = await post(base, "/user/signin", {
      email: "container@local.invalid",
      password,
    });
    const keyhash = crypto.randomBytes(32).toString("hex");
    const vault = {
      ...(await post(base, "/vault/create", {
        token: account.token,
        name: "Container fixture",
        salt: "container-fixture-salt",
        keyhash,
        encryption_version: 3,
      })),
      keyhash,
    };
    const client = await connection(base, account.token, vault);
    const ciphertext = crypto.randomBytes(2097152 + 37);
    client.send({
      op: "push",
      path: "opaque-container-path",
      hash: "opaque-container-hash",
      extension: "bin",
      size: ciphertext.length,
      pieces: 2,
    });
    assert.equal((await client.response()).res, "upload");
    client.socket.send(ciphertext.subarray(0, 2097152));
    assert.equal((await client.response()).res, "ok");
    client.socket.send(ciphertext.subarray(2097152));
    assert.equal((await client.response()).res, "ok");
    client.send({ op: "history", path: "opaque-container-path", last: 0 });
    const history = await client.response();
    assert.equal(history.items.length, 1);
    const uid = history.items[0].uid;
    client.socket.terminate();
    await pull(base, account.token, vault, uid, ciphertext);
    record(
      "real WebSocket upgrade and multi-piece ciphertext round trip through published port",
    );

    compose(
      prefix,
      [
        "exec",
        "-T",
        "vault-sync",
        "/usr/local/bin/vault-sync-server",
        "users",
        "add",
        "--email",
        "coowner@local.invalid",
        "--name",
        "Co-owner",
        "--password-stdin",
      ],
      { input: password + "\n" },
    );
    compose(prefix, [
      "exec",
      "-T",
      "vault-sync",
      "/usr/local/bin/vault-sync-server",
      "vaults",
      "grant",
      "--vault",
      vault.id,
      "--user",
      "coowner@local.invalid",
    ]);
    const coowner = await post(base, "/user/signin", {
      email: "coowner@local.invalid",
      password,
    });
    await pull(base, coowner.token, vault, uid, ciphertext);
    record(
      "docker exec administers live users/co-ownership over the private Unix socket",
    );
    compose(prefix, ["restart", "vault-sync"]);
    // Docker can reallocate an ephemeral published port when restarting.
    base = address(prefix);
    await waitReady(base);
    await post(base, "/user/info", { token: account.token });
    await pull(base, account.token, vault, uid, ciphertext);
    record("container restart preserves session and acknowledged ciphertext");

    const locked = compose(
      prefix,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "vault-sync",
        "backup",
        "--output",
        "/backups/locked.tar.gz",
      ],
      { allowedFailure: true },
    );
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /data directory is in use/);
    record("offline backup refuses a concurrently running service");

    compose(prefix, ["stop", "vault-sync"]);
    const full = docker(
      [
        "run",
        "--rm",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--mount",
        "type=volume,src=" + prefix + "_config,dst=/etc/vault-sync",
        "--mount",
        "type=volume,src=" + prefix + "_data,dst=/var/lib/vault-sync",
        "--tmpfs",
        "/backups:rw,size=1m,uid=10001,gid=10001,mode=0700",
        image,
        "backup",
        "--format",
        "zip",
        "--output",
        "/backups/full.zip",
      ],
      { allowedFailure: true },
    );
    assert.notEqual(full.status, 0);
    assert.match(full.stderr, /space|full|large/i);
    record(
      "bounded backup tmpfs produces a real write failure without publishing a successful archive",
    );

    compose(prefix, [
      "run",
      "--no-deps",
      "--name",
      backupContainer,
      "-T",
      "vault-sync",
      "backup",
      "--output",
      "/backups/fixture-backup.tar.gz",
    ]);
    const archive = path.join(temp, "backup.tar.gz");
    docker([
      "cp",
      backupContainer + ":/backups/fixture-backup.tar.gz",
      archive,
    ]);
    docker(["rm", backupContainer]);
    compose(
      restored,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "vault-sync",
        "restore",
        "--archive",
        "-",
        "--data-dir",
        "/var/lib/vault-sync/restored",
      ],
      { input: fs.readFileSync(archive) },
    );
    compose(restored, [
      "up",
      "--detach",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "90",
    ]);
    const restoredBase = address(restored);
    await post(restoredBase, "/user/info", { token: account.token });
    await pull(restoredBase, account.token, vault, uid, ciphertext);
    record(
      "offline backup exported and streamed into fresh Compose volumes with session/ciphertext intact",
    );

    compose(restored, ["stop", "vault-sync"]);
    docker([
      "run",
      "--detach",
      "--name",
      plainContainer,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      "type=volume,src=" + restored + "_config,dst=/etc/vault-sync",
      "--mount",
      "type=volume,src=" + restored + "_data,dst=/var/lib/vault-sync",
      "--publish",
      "127.0.0.1::8080",
      image,
    ]);
    const plainBase =
      "http://" + docker(["port", plainContainer, "8080/tcp"]).stdout.trim();
    await waitReady(plainBase);
    docker([
      "exec",
      plainContainer,
      "/usr/local/bin/vault-sync-server",
      "status",
    ]);
    await pull(plainBase, account.token, vault, uid, ciphertext);
    record(
      "plain docker run serves the same durable data with no Compose dependency",
    );

    console.log(JSON.stringify({ status: "passed", image, checks }, null, 2));
  } catch (error) {
    console.error(compose(prefix, ["logs", "--no-color", "--tail", "50"], { allowedFailure: true }).stdout);
    throw error;
  } finally {
    docker(["rm", "--force", backupContainer, plainContainer], {
      allowedFailure: true,
    });
    for (const project of [prefix, restored])
      compose(project, ["down", "--volumes", "--remove-orphans"], {
        allowedFailure: true,
      });
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
