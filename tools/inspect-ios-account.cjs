"use strict";
// Development only. Reads an explicitly supplied private client source file,
// extracts selected definitions into an isolated mocked VM, and reports behavior.
// No original client source, credentials or request bodies are written to output.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const acorn = require("acorn");

const expected =
  "ffd620f9ee985cc4eb93ab25ba5871a33c9460b68035f2d74c8d4ddc2d43ef91";

function inspect(file) {
  if (!file || !path.isAbsolute(file))
    throw Error(
      "Supply OBSIDIAN_IOS_SOURCE as an absolute path to the privately exported iOS app.js.",
    );
  const resolved = fs.realpathSync(file);
  if (resolved.startsWith("/Applications/"))
    throw Error("Installed application paths are excluded.");
  const source = fs.readFileSync(resolved, "utf8");
  const hash = crypto.createHash("sha256").update(source).digest("hex");
  if (hash !== expected)
    throw Error(
      "Unqualified iOS source fingerprint; inspect it before adding an adapter.",
    );
  const ast = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  assert.equal(ast.body[0].expression.callee.type, "ArrowFunctionExpression");
  const bindings = new Map();
  for (const node of ast.body[0].expression.callee.body.body) {
    if (node.type === "VariableDeclaration")
      for (const item of node.declarations) {
        if (item.id.type === "Identifier") bindings.set(item.id.name, item);
      }
    if (node.type === "FunctionDeclaration") bindings.set(node.id.name, node);
  }
  const slice = (node) => source.slice(node.start, node.end);
  for (const name of [
    "be",
    "$P",
    "sr",
    "nj",
    "aj",
    "oj",
    "ij",
    "Hs",
    "_P",
    "Xq",
  ])
    assert.ok(bindings.has(name), name);
  const account = bindings.get("be");
  assert.equal(account.init.type, "NewExpression");
  assert.equal(account.init.callee.name, "$P");
  assert.equal(slice(bindings.get("_P")), "_P=fetch");
  let sync;
  let pluginLoader;
  let apiExports;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "MethodDefinition" && node.key.name === "_sync")
      sync = node;
    if (node.type === "FunctionDeclaration" && node.id.name === "gse")
      pluginLoader = node;
    if (
      node.type === "CallExpression" &&
      node.callee.name === "ya" &&
      node.arguments[0]?.name === "wz"
    )
      apiExports = node.arguments[1];
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(ast);
  assert.ok(sync && pluginLoader && apiExports);
  assert.match(
    slice(sync),
    /if\(!be\.token\)throw new Error\("Not logged in"\)/,
  );
  assert.match(slice(pluginLoader), /window\.eval\(/);
  const directAccountExports = apiExports.properties
    .filter((property) =>
      /(?:^|[^\w$])(?:be|\$P)(?![\w$])/.test(slice(property.value)),
    )
    .map((property) => property.key.name || property.key.value);
  assert.deepEqual(directAccountExports, []);
  const definitions = [
    "var " +
      slice(bindings.get("_P")) +
      "," +
      slice(bindings.get("Xq")) +
      "," +
      slice(bindings.get("Hs")) +
      ";var Qq='';",
    ...["sr", "nj", "aj", "oj", "ij"].map((name) => slice(bindings.get(name))),
    "var Dj='obsidian-account'," +
      slice(bindings.get("$P")) +
      "," +
      slice(account) +
      ";",
    "var engine={" + slice(sync) + "};",
    "var " + slice(bindings.get("ICe")) + ";" + slice(pluginLoader),
  ].join("\n");
  return {
    hash,
    definitions,
    directAccountExports,
    offsets: {
      capturedFetch: bindings.get("_P").start,
      accountClass: bindings.get("$P").start,
      accountSingleton: account.start,
      accountRequest: bindings.get("sr").start,
      fileEngine: sync.start,
      pluginGlobalEval: pluginLoader.start,
    },
  };
}

function harness(definitions, storage = new Map()) {
  const calls = [];
  let revoked = false;
  let lateCalls = 0;
  const context = vm.createContext({
    // Only synthetic fixtures; there is no actual HTTP or local file API here.
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      const result = revoked
        ? { error: "Not logged in" }
        : url.endsWith("/user/signin")
          ? {
              token: "synthetic-custom-session",
              email: "test@local.invalid",
              name: "Test",
              license: "",
            }
          : url.endsWith("/user/signout")
            ? { res: "ok" }
            : {
                email: "test@local.invalid",
                name: "Test refreshed",
                license: "",
              };
      return { ok: true, status: 200, json: async () => result };
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    Ei: class FileSystemAdapter {},
  });
  vm.runInContext("globalThis.window=globalThis", context);
  // The facade is an explicit DEVELOPMENT harness injection. The real plugin
  // loader does not expose it and cannot access this IIFE's account binding.
  const facade = new vm.Script(
    "(()=>{" +
      definitions +
      `
    return {
      loggedIn:()=>!!be.token,
      login:(...args)=>be.login(...args),
      refresh:()=>be.getUserInfo(),
      logout:()=>be.logout(),
      pluginScopeProbe:()=>{
        const factory=gse("module.exports=typeof be;", "private-account-probe");
        const module={exports:{}};
        factory(()=>{throw new Error("No module access in scope probe")},module,module.exports);
        return module.exports;
      },
      probe:()=>engine._sync.call({pause:false,vault:{adapter:{}},
        backoff:{isReady:()=>true},getServer:async()=>null})
    };})()`,
  );
  const api = facade.runInContext(context, { timeout: 5000 });
  return {
    api,
    calls,
    storage,
    globalAccountType: () => vm.runInContext("typeof be", context),
    replaceFetch() {
      context.fetch = async () => {
        lateCalls++;
        throw Error("Late replacement must not receive captured requests");
      };
    },
    lateCalls: () => lateCalls,
    revoke() {
      revoked = true;
    },
  };
}

async function run(file) {
  const info = inspect(file);
  const checks = [];
  function pass(name) {
    checks.push({ name, status: "passed" });
  }
  pass(
    "Supplied iOS source fingerprint and closure/request/engine shapes match inspected source",
  );
  pass(
    "SDK export table has no direct account-singleton or account-class export",
  );
  const first = harness(info.definitions);
  assert.equal(first.globalAccountType(), "undefined");
  assert.equal(first.api.loggedIn(), false);
  pass(
    "Account binding is private to the module; it is absent from the global scope",
  );
  assert.equal(first.api.pluginScopeProbe(), "undefined");
  pass(
    "Original plugin loader evaluates plugin code in global scope, without the enclosing account binding",
  );
  await assert.rejects(first.api.probe(), /Not logged in/);
  pass(
    "Original iOS file engine rejects synchronization without its captured account token",
  );
  first.storage.set("plugin-owned-session", "synthetic-custom-session");
  await assert.rejects(first.api.probe(), /Not logged in/);
  pass(
    "A separately stored plugin session does not satisfy the native account gate",
  );
  first.storage.set(
    "obsidian-account",
    JSON.stringify({ token: "synthetic-custom-session" }),
  );
  await assert.rejects(first.api.probe(), /Not logged in/);
  pass(
    "Writing native account storage after construction does not update the captured account instance",
  );
  const restarted = harness(info.definitions, first.storage);
  assert.equal(restarted.api.loggedIn(), true);
  assert.equal(await restarted.api.probe(), false);
  pass(
    "A new native account instance reads persisted state; this only passes the gate, not a transfer test",
  );
  await restarted.api.refresh();
  const sent = restarted.calls.at(-1);
  assert.equal(sent.url, "https://api.obsidian.md/user/info");
  assert.equal(sent.body.token, "synthetic-custom-session");
  pass(
    "Blind persisted-token restoration would send that token to the official account API during refresh (mock HTTP only)",
  );
  const late = harness(info.definitions);
  late.replaceFetch();
  await late.api.login("test@local.invalid", "synthetic-password", "");
  assert.equal(late.lateCalls(), 0);
  assert.equal(late.calls[0].url, "https://api.obsidian.md/user/signin");
  pass(
    "Replacing global fetch after module initialization does not intercept native account login",
  );
  assert.equal(late.api.loggedIn(), true);
  assert.equal(await late.api.probe(), false);
  pass(
    "Native login updates the exact account instance used by the unchanged file engine",
  );
  late.revoke();
  await assert.rejects(late.api.refresh(), /Not logged in/);
  assert.equal(late.api.loggedIn(), false);
  await assert.rejects(late.api.probe(), /Not logged in/);
  pass(
    "Native invalid-session refresh clears the captured token and blocks the file engine again",
  );
  const logout = harness(info.definitions);
  await logout.api.login("test@local.invalid", "synthetic-password", "");
  await logout.api.logout();
  assert.equal(logout.api.loggedIn(), false);
  assert.equal(logout.calls.at(-1).url, "https://api.obsidian.md/user/signout");
  pass(
    "Native logout revokes through its captured account API and clears persisted session fields",
  );
  return {
    status:
      "source inspected; listed mocked contracts passed; mobile integration remains blocked",
    at: new Date().toISOString(),
    source: {
      reportedAppVersion: "1.15.1",
      sha256: info.hash,
      offsetsUtf16: info.offsets,
    },
    mode: "Selected original functions in isolated VM; all HTTP/storage are synthetic mocks; no app launched",
    checks,
    unresolved: [
      "No callable reversible plugin-level native-account session integration was found.",
      "Captured HTTP fetch routing below the browser/native bridge is not established on iOS.",
      "Absence of a direct export is not proof that every possible indirect integration is impossible.",
      "No real iPhone custom login, synchronization, startup/reconnect or background test was performed.",
    ],
    distribution:
      "Only independent tooling, fingerprints and redacted results are distributed; source stays private.",
  };
}

if (require.main === module) {
  run(process.env.OBSIDIAN_IOS_SOURCE)
    .then((report) => {
      const text = JSON.stringify(report, null, 2) + "\n";
      if (process.env.SYNC_IOS_INSPECTION_REPORT)
        fs.writeFileSync(process.env.SYNC_IOS_INSPECTION_REPORT, text, {
          mode: 0o600,
        });
      process.stdout.write(text);
    })
    .catch(() => {
      // Errors may contain selected source text; never include them in diagnostics.
      process.stderr.write(
        "iOS inspection failed; verify source fingerprint and inspected contracts privately.\n",
      );
      process.exitCode = 1;
    });
}

module.exports = { run };
