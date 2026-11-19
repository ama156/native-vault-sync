"use strict";
// Original iOS engine/filter/crypto/transport + independent adapter, using a synthetic
// vault/secret store and a disposable Go subprocess. No actual app is launched.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  net = require("node:net"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const assert = require("node:assert/strict"),
  { once } = require("node:events");
const { createRuntime } = require("./ios-test-runtime.cjs");
async function run() {
  const binary = process.env.SYNC_TEST_BINARY,
    source = process.env.OBSIDIAN_IOS_SOURCE;
  if (
    !binary ||
    !path.isAbsolute(binary) ||
    binary.startsWith("/Applications/")
  )
    throw Error("Supply a sandbox server binary.");
  const dir = fs.mkdtempSync(
    path.join(process.env.SYNC_TEST_TMPDIR || os.tmpdir(), "ios-sync-proof-"),
  );
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const server = "http://127.0.0.1:" + port,
    config = path.join(dir, "config.json"),
    password = crypto.randomBytes(20).toString("hex");
  const initialized = cp.spawnSync(
    binary,
    [
      "init",
      "--config",
      config,
      "--data-dir",
      path.join(dir, "data"),
      "--public-url",
      server,
      "--email",
      "ios-proof@local.invalid",
      "--password-stdin",
    ],
    { input: password + "\n", encoding: "utf8" },
  );
  if (initialized.status !== 0) throw Error("Disposable initialization failed");
  const cfg = JSON.parse(fs.readFileSync(config));
  cfg.listen = "127.0.0.1:" + port;
  fs.writeFileSync(config, JSON.stringify(cfg));
  const child = cp.spawn(binary, ["serve", "--config", config], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const clients = [],
    checks = [],
    requests = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error("Disposable server did not start")),
        15000,
      );
      child.stderr.on("data", (bytes) => {
        if (bytes.toString().includes("server ready")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(Error("Disposable server exited"));
      });
    });
    async function post(route, payload) {
      requests.push(route);
      const response = await fetch(server + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
      });
      const result = await response.json();
      if (!response.ok || result.error)
        throw Error("Disposable operation failed: " + route);
      return result;
    }
    function runtime() {
      return createRuntime(source);
    }
    function secrets() {
      const data = new Map();
      return {
        getSecret: (key) => data.get(key),
        setSecret: (key, value) => data.set(key, value),
        deleteSecret: (key) => data.delete(key),
        isEncryptionAvailable: () => true,
      };
    }
    async function makeClient(
      store,
      saved = false,
      email = "ios-proof@local.invalid",
    ) {
      const r = runtime(),
        engine = r.createEngine();
      const settings = { server, enabled: false, vaultId: "" };
      engine.native.app.secretStorage = store;
      engine.native.app.internalPlugins = {
        getPluginById: () => ({ enabled: true, instance: engine.native }),
      };
      const controller = new r.bridge.IOSController(
        engine.native.app,
        settings,
        async (options) => {
          assert.equal(new URL(options.url).origin, server);
          requests.push(new URL(options.url).pathname);
          const response = await fetch(options.url, {
            ...options,
            redirect: "error",
          });
          return { status: response.status, json: await response.json() };
        },
        async () => {},
      );
      assert.equal(await controller.establish(email, password, saved), true);
      const session = controller.session;
      await assert.rejects(
        r.nativeAccountCall("/vault/list"),
        /Bridge settings/,
      );
      assert.equal(
        r.traces.some((t) => t.kind === "native-account-fetch"),
        false,
      );
      const client = { r, ...engine, session, controller };
      clients.push(client);
      return client;
    }
    const storageA = secrets(),
      a = await makeClient(storageA);
    const salt = "synthetic-ios-vault-salt",
      vaultPassword = "synthetic-vault-encryption-password";
    const key = await a.r.derive(vaultPassword, salt),
      provider = await a.r.provider(3, key, salt);
    const vault = await post("/vault/create", {
      token: a.session.token(),
      name: "Disposable iOS proof",
      salt,
      keyhash: provider.keyHash,
      encryption_version: 3,
    });
    async function setup(client) {
      await client.controller.connect(vault, vaultPassword);
      for (let n = 0; n < 300 && !client.native.ready; n++)
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(client.native.ready, true);
    }
    await assert.rejects(
      a.controller.connect(vault, "incorrect-synthetic-password"),
      /unlock|login|password/,
    );
    assert.equal(a.native.vaultId, null);
    checks.push(
      "Wrong vault password is rejected before upload, and only the unsuccessful new remote setup is rolled back",
    );
    await setup(a);
    checks.push(
      "Original iOS account gate passes only after verified custom login; native HTTP serialization is blocked",
    );
    let secondEmail = "ios-proof@local.invalid";
    if (process.env.SYNC_IOS_MULTIUSER === "1") {
      secondEmail = "ios-coowner@local.invalid";
      for (const args of [
        [
          "users",
          "add",
          "--config",
          config,
          "--email",
          secondEmail,
          "--name",
          "Synthetic co-owner",
          "--password-stdin",
        ],
        [
          "vaults",
          "grant",
          "--config",
          config,
          "--user",
          secondEmail,
          "--vault",
          vault.id,
        ],
      ]) {
        const result = cp.spawnSync(binary, args, {
          input: password + "\n",
          encoding: "utf8",
        });
        if (result.status !== 0)
          throw Error("Disposable co-owner administration failed");
      }
      checks.push(
        "Two distinct custom accounts receive administrator-granted co-ownership of the same encrypted vault",
      );
    }
    const b = await makeClient(secrets(), false, secondEmail);
    await setup(b);
    checks.push(
      "Two original iOS native transports authenticate and reach ready through direct custom WebSockets with iOS Origin",
    );
    async function drive(client) {
      for (let n = 0; n < 800; n++) {
        if (!(await client.native._sync())) return;
        // Native requestSync yields between iterations; preserve that scheduling.
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error(
        "Native synthetic-vault loop did not settle (stage " +
          checks.length +
          ", status " +
          client.native.syncStatus +
          ")",
      );
    }
    await a.write(
      "Proof.md",
      "# Native iOS proof\n\nOriginal engine, custom session.\n",
    );
    await drive(a);
    await new Promise((r) => setTimeout(r, 50));
    await drive(b);
    assert.equal(
      await b.vault.adapter.read("Proof.md"),
      await a.vault.adapter.read("Proof.md"),
    );
    checks.push(
      "Unmodified iOS file-engine loop uploads and downloads encrypted Markdown using synthetic vault adapters",
    );
    await b.write("Reply.md", "# Reply from second original engine\n");
    await drive(b);
    await new Promise((r) => setTimeout(r, 50));
    await drive(a);
    assert.equal(
      await a.vault.adapter.read("Reply.md"),
      await b.vault.adapter.read("Reply.md"),
    );
    checks.push("Bidirectional native-engine encrypted note transfer");
    const large = crypto.randomBytes(2097152 + 37);
    await a.write("Large.png", Uint8Array.from(large).buffer);
    await a.write("Empty.md", "");
    await drive(a);
    await new Promise((r) => setTimeout(r, 50));
    await drive(b);
    assert.deepEqual(
      Buffer.from(await b.vault.adapter.readBinary("Large.png")),
      large,
    );
    assert.equal((await b.vault.adapter.readBinary("Empty.md")).byteLength, 0);
    checks.push(
      "Native encryption/decryption and engine transfer preserve empty files and attachments over 2 MiB",
    );
    // Exercise the original category filter, rather than treating extensions
    // as an allowlist. These are opaque synthetic bytes, not rendered media.
    assert.deepEqual(Array.from(a.native.filter.allowTypes), [
      "image",
      "audio",
      "pdf",
      "video",
    ]);
    async function transfer(from, to, name, bytes) {
      await from.write(name, Uint8Array.from(bytes).buffer);
      await drive(from);
      await new Promise((r) => setTimeout(r, 50));
      await drive(to);
      assert.deepEqual(
        Buffer.from(await to.vault.adapter.readBinary(name)),
        bytes,
      );
    }
    await transfer(a, b, "Small-from-a.png", crypto.randomBytes(751));
    await transfer(b, a, "Small-from-b.pdf", crypto.randomBytes(1201));
    await transfer(b, a, "Large-from-b.png", crypto.randomBytes(2097152 + 79));
    await a.write(
      "Default-filter.zip",
      Uint8Array.from(crypto.randomBytes(99)).buffer,
    );
    await b.write(
      "Default-filter.epub",
      Uint8Array.from(crypto.randomBytes(101)).buffer,
    );
    await drive(a);
    await drive(b);
    assert.equal(b.files.has("Default-filter.zip"), false);
    assert.equal(a.files.has("Default-filter.epub"), false);
    await a.controller.setFileType("unsupported", true);
    await b.controller.setFileType("unsupported", true);
    await drive(a);
    await drive(b);
    await drive(a);
    assert.deepEqual(
      Buffer.from(await b.vault.adapter.readBinary("Default-filter.zip")),
      Buffer.from(await a.vault.adapter.readBinary("Default-filter.zip")),
    );
    assert.deepEqual(
      Buffer.from(await a.vault.adapter.readBinary("Default-filter.epub")),
      Buffer.from(await b.vault.adapter.readBinary("Default-filter.epub")),
    );
    checks.push(
      "Original native category filter transfers PNG/PDF and a >2 MiB reverse-direction PNG; ZIP/EPUB remain excluded by default and transfer after enabling all other types",
    );
    await b.controller.setFileType("image", false);
    await a.write(
      "Excluded-until-enabled.png",
      Uint8Array.from(crypto.randomBytes(721)).buffer,
    );
    await drive(a);
    await new Promise((r) => setTimeout(r, 50));
    await drive(b);
    assert.equal(b.files.has("Excluded-until-enabled.png"), false);
    const cursorBeforeEnable = b.native.version;
    await b.controller.setFileType("image", true);
    await drive(b);
    assert.deepEqual(
      Buffer.from(
        await b.vault.adapter.readBinary("Excluded-until-enabled.png"),
      ),
      Buffer.from(
        await a.vault.adapter.readBinary("Excluded-until-enabled.png"),
      ),
    );
    assert.ok(b.native.version >= cursorBeforeEnable);
    checks.push(
      "Bridge selective-sync setter requeues a previously ignored remote PNG and downloads it without resetting the revision cursor",
    );

    await a.session.refresh();
    const restarted = await makeClient(storageA, true);
    await setup(restarted);
    await drive(restarted);
    assert.equal(
      await restarted.vault.adapter.read("Proof.md"),
      await a.vault.adapter.read("Proof.md"),
    );
    checks.push(
      "New runtime restores the device secret, recaptures a fresh native account, and replays the remote vault",
    );
    a.native.server.disconnect();
    a.native.server = null;
    await a.native.getServer();
    for (let n = 0; n < 300 && !a.native.ready; n++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(a.native.ready, true);
    checks.push(
      "Native reconnect creates a replacement transport with the adapter restored on that instance",
    );
    await post("/user/signout", { token: b.session.token() });
    await assert.rejects(b.session.refresh(), /expired|revoked/);
    assert.equal(b.session.authenticated, false);
    checks.push(
      "Server revocation clears the custom session and closes the native account presence gate",
    );
    for (const client of clients) {
      assert.equal(client.r.nativeStorage.size, 0);
      assert.equal(
        client.r.traces.some((t) => t.kind === "native-account-fetch"),
        false,
      );
      assert.equal(
        client.r.traces
          .filter((t) => t.kind === "socket")
          .every((t) => t.origin === server.replace("http:", "ws:")),
        true,
      );
    }
    checks.push(
      "No native account storage writes and no official HTTP calls; all socket destinations are the disposable server",
    );
    return {
      status:
        "passed for isolated source integration; real iPhone qualification pending",
      at: new Date().toISOString(),
      sourceSha256: a.r.sourceHash,
      mode: "Original iOS engine/filter/crypto/transport in isolated VM, synthetic vault/secret adapters, real Go listener",
      checks,
      limits: [
        "No actual iPhone app run or filesystem lifecycle test.",
        "Native mobile scrypt/WebView networking, real secure storage and background/resume are not qualified.",
        "Fresh account state only; existing and saved signed-out accounts remain unsupported.",
      ],
    };
  } finally {
    for (const client of clients) {
      client.native.server?.disconnect();
      client.native.server = null;
      await client.controller.stop(false);
    }
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run()
  .then((report) => {
    const text = JSON.stringify(report, null, 2) + "\n";
    if (process.env.SYNC_IOS_PROOF_REPORT)
      fs.writeFileSync(process.env.SYNC_IOS_PROOF_REPORT, text, {
        mode: 0o600,
      });
    process.stdout.write(text);
  })
  .catch((error) => {
    process.stderr.write("iOS isolated proof failed: " + error.message + "\n");
    process.exitCode = 1;
  });
