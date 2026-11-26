"use strict";

const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { load187 } = require("./native-runtime.cjs");

async function run() {
  const [electron, bundle, bootstrap, reference, binary] = await Promise.all(
    ["SYNC_TEST_ELECTRON", "OBSIDIAN_TEST_ASAR", "SYNC_TEST_BOOTSTRAP_ASAR",
      "SYNC_TEST_REFERENCE_ASAR", "SYNC_TEST_BINARY"].map((name) => {
      if (!process.env[name]) throw Error("Set " + name + " to a disposable test resource.");
      return fs.realpath(process.env[name]);
    }),
  );
  if ([electron, bundle, bootstrap, reference, binary].some((file) =>
    file.startsWith("/Applications/") || file.includes("/Library/Application Support/obsidian/")))
    throw Error("Provide independent sandbox copies of the runtime and resources.");
  const dir = await fs.mkdtemp("/tmp/vault-direct-");
  const children = new Set();
  function start(file, args, env = {}) {
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: "ignore" });
    children.add(child);
    child.on("exit", () => children.delete(child));
    return child;
  }
  async function stop(child) {
    if (!children.has(child)) return;
    const stopped = once(child, "exit");
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await stopped; } finally { clearTimeout(kill); }
  }
  async function waitFor(check, label, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("Timed out waiting for " + label);
  }
  try {
    const portProbe = net.createServer().listen(0, "127.0.0.1");
    await once(portProbe, "listening");
    const address = "127.0.0.1:" + portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    const origin = "http://" + address;
    const config = path.join(dir, "server.json");
    const email = "mac-proof@local.invalid";
    const password = randomBytes(24).toString("hex");
    const vaultPassword = randomBytes(24).toString("hex");
    execFileSync(binary, ["init", "--config", config, "--data-dir", path.join(dir, "data"),
      "--public-url", origin, "--listen", address, "--email", email, "--password-stdin"],
      { input: password + "\n" });
    start(binary, ["serve", "--config", config]);
    await waitFor(() => fetch(origin + "/healthz").then((r) => r.ok, () => false), "server");
    async function post(route, data) {
      const response = await fetch(origin + route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      assert.ok(response.ok && !result.error, route);
      return result;
    }
    const account = await post("/user/signin", { email, password });
    const salt = randomBytes(16).toString("hex");
    const { derive, provider } = load187(reference);
    const crypto = await provider(3, await derive(vaultPassword, salt), salt);
    await post("/vault/create", { token: account.token, salt, keyhash: crypto.keyHash,
      encryption_version: 3, name: "Disposable Direct Sync" });

    function launch(label) {
      const child = start(electron, [path.join(__dirname, "sandbox-runner.cjs"),
        "--use-mock-keychain", "--no-proxy-server",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"], {
        SYNC_TEST_SANDBOX: path.join(dir, "clients"),
        SYNC_TEST_PROFILE: label,
        SYNC_TEST_MAC_DIRECT: "1",
        OBSIDIAN_TEST_ASAR: bundle,
        SYNC_TEST_BOOTSTRAP_ASAR: bootstrap,
        SYNC_TEST_SERVER: origin,
      });
      return { child, label };
    }
    async function evaluate(client, expression, target) {
      const { label } = client, id = randomBytes(8).toString("hex");
      const cmd = path.join(dir, "clients", "command-" + label + ".json");
      const result = path.join(dir, "clients", "result-" + label + ".json");
      await waitFor(async () => fs.stat(path.dirname(cmd)).then(() => true, () => false), "sandbox directory");
      const code = `(async () => {
        const p = globalThis.app?.plugins?.plugins?.["vault-sync-bridge"];
        const c = p?.controller;
        const n = globalThis.app?.internalPlugins?.getPluginById("sync")?.instance;
        return (${expression});
      })()`;
      await fs.writeFile(cmd + ".tmp", JSON.stringify({ id, code, target }), { mode: 0o600 });
      await fs.rename(cmd + ".tmp", cmd);
      const reply = await waitFor(async () => {
        if (client.child.exitCode !== null) throw Error("Disposable Mac app exited");
        const json = await fs.readFile(result, "utf8").then(JSON.parse, () => null);
        return json?.id === id && json;
      }, "sandbox evaluation");
      if (reply.error) throw Error(reply.error);
      return reply.value;
    }
    async function ready(client) {
      let state;
      try {
        await waitFor(async () => {
          state = await evaluate(client, `(() => {
            if (!p) [...document.querySelectorAll("button")].find((button) =>
              /^(trust (the )?author|enable (community )?plugins)/i.test(button.textContent.trim())
            )?.click();
            return {
            hasApp: Boolean(globalThis.app),
            bridge: Boolean(p),
            state: p?.state,
            direct: Boolean(c),
            coreSync: Boolean(n),
            initialized: n?.initialized,
            dataLoaded: n?.dataLoaded,
            platform: navigator.platform,
            screen: document.body.innerText.slice(0, 200),
            buttons: [...document.querySelectorAll(".modal button")].map((button) => button.textContent)
          }; })()`);
          return state.direct && state.initialized && state.dataLoaded;
        }, "plugin and native Sync", 12000);
      } catch (error) {
        throw Error(error.message + ": " + JSON.stringify(state));
      }
    }
    async function connect(client) {
      await ready(client);
      await evaluate(client, `(async () => {
        await c.establish(${JSON.stringify(email)}, ${JSON.stringify(password)});
        const vaults = await c.vaults();
        await c.connect(vaults[0], ${JSON.stringify(vaultPassword)});
        return true;
      })()`);
      await checkConnection(client);
    }
    async function checkConnection(client) {
      await waitFor(() => evaluate(client, "Boolean(c?.session?.authenticated && n?.ready)"),
        "direct sync ready");
      assert.deepEqual(await evaluate(client, `({
        socket: n.server.socket.url,
        routed: Boolean(p.routingActive || p.relay || p.coordinator),
        nativeAccountSaved: localStorage.getItem("obsidian-account") !== null
      })`), { socket: "ws://" + address + "/sync", routed: false, nativeAccountSaved: false });
    }
    let a = launch("a");
    await ready(a);
    await evaluate(a, `(async () => {
      await app.setting.open();
      await app.setting.openTabById("vault-sync-bridge");
      return true;
    })()`);
    const hasSharedSettings = 'document.body.innerText.includes("Sign in to custom server")';
    await waitFor(async () => {
      if (await evaluate(a, hasSharedSettings)) return true;
      try { return await evaluate(a, hasSharedSettings, "settings"); }
      catch (error) {
        if (error.message === "Requested test window unavailable") return false;
        throw error;
      }
    }, "shared Direct Sync settings on Mac");
    await connect(a);
    await evaluate(a, 'app.vault.create("direct-proof.md", "Mac direct Sync test").then(() => true)');
    const b = launch("b");
    await connect(b);
    await waitFor(() => evaluate(b, 'app.vault.getAbstractFileByPath("direct-proof.md") !== null'),
      "encrypted note download");
    await evaluate(b, `(async () => {
      await c.setFileType("image", true);
      const bytes = new Uint8Array(2097152 + 73); bytes[10] = 42;
      await app.vault.createBinary("direct-proof.png", bytes.buffer);
      return true;
    })()`);
    await evaluate(a, 'c.setFileType("image", true).then(() => true)');
    await waitFor(() => evaluate(a, `(async () => {
      const file = app.vault.getAbstractFileByPath("direct-proof.png");
      if (!file) return false;
      const data = new Uint8Array(await app.vault.readBinary(file));
      return data.length === 2097152 + 73 && data[10] === 42;
    })()`), "reverse multipart attachment");
    await stop(a.child);
    a = launch("a");
    await ready(a);
    await checkConnection(a);
    await evaluate(a, "c.signOut().then(() => true)");
    assert.equal(await evaluate(a, "n.getPause() && !n.server && !c.session"), true);
    console.log(JSON.stringify({ result: "passed", app: "macOS 1.15.1", architecture: process.arch,
      checks: ["Shared Direct Sync settings on Mac", "Direct login and vault selection", "Native encrypted note sync",
        "Reverse multipart attachment and selective Sync", "Session restore on restart",
        "Sign-out pauses and closes Sync", "Direct socket with no desktop relay or native account record"] }, null, 2));
  } finally {
    await Promise.all([...children].map(stop));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
