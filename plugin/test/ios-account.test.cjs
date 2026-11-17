"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const {
  captureFreshAccount,
  fingerprint,
  bindAccount,
} = require("../src/ios-account.cjs");
const { MobileSession, SessionExpired } = require("../src/mobile-session.cjs");
const {
  IOSController,
  prepareEmptyNativeAccount,
} = require("../src/ios-controller.cjs");
const previousCrypto = globalThis.crypto;
if (!globalThis.crypto) globalThis.crypto = webcrypto;

class AccountFixture {
  constructor(saved) {
    this.keyValidation = "";
    this.company = "";
    this.expiry = 0;
    this.seats = 0;
    if (saved) Object.assign(this, saved);
  }
}
function fixture(saved, failure = false) {
  const account = new AccountFixture(saved);
  const native = {
    async asyncGetServer() {
      if (failure) throw Error("Synthetic failure");
      if (this.host && account.token && this.vaultId && this.encryptionProvider)
        throw Error("Probe must not create a transport");
      return null;
    },
  };
  return { native, account };
}
async function expected(native) {
  return {
    asyncGetServer: await fingerprint(native.asyncGetServer),
    accountClass: await fingerprint(AccountFixture),
  };
}

test("account capture restores the global descriptor before its promise settles and leaves the native instance unchanged", async () => {
  const { native, account } = fixture();
  const snapshot = Object.getOwnPropertyDescriptors(account);
  const nativeSnapshot = Object.getOwnPropertyDescriptors(native);
  const result = await captureFreshAccount(native, await expected(native));
  assert.equal(result, account);
  assert.equal(Object.hasOwn(Object.prototype, "token"), false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(account), snapshot);
  assert.deepEqual(Object.getOwnPropertyDescriptors(native), nativeSnapshot);
});

test("capture refuses existing official-shaped and saved signed-out accounts without changing them", async () => {
  for (const saved of [
    { token: "secret-official", email: "owner@example.com" },
    { token: "", email: "" },
  ]) {
    const { native, account } = fixture(saved),
      before = Object.getOwnPropertyDescriptors(account);
    await assert.rejects(
      captureFreshAccount(native, await expected(native)),
      /fresh native account/,
    );
    assert.deepEqual(Object.getOwnPropertyDescriptors(account), before);
    assert.equal(Object.hasOwn(Object.prototype, "token"), false);
  }
});

test("capture refuses mismatches and existing prototype instrumentation, and cleans up thrown probes", async () => {
  const { native } = fixture();
  await assert.rejects(
    captureFreshAccount(native, { asyncGetServer: "unqualified" }),
    /Unqualified/,
  );
  const config = await expected(native);
  Object.defineProperty(Object.prototype, "token", {
    configurable: true,
    value: "another-owner",
  });
  try {
    await assert.rejects(
      captureFreshAccount(native, config),
      /cannot be installed safely/,
    );
    assert.equal(Object.prototype.token, "another-owner");
  } finally {
    delete Object.prototype.token;
  }
  const throwing = fixture(undefined, true);
  await assert.rejects(
    captureFreshAccount(throwing.native, await expected(throwing.native)),
    /Synthetic failure/,
  );
  assert.equal(Object.hasOwn(Object.prototype, "token"), false);
});

test("native session handle blocks both JSON and URL coercion before any captured native request", async () => {
  const account = new AccountFixture();
  let nativeRequests = 0,
    refreshed = 0;
  const session = {
    authenticated: true,
    info: { email: "custom@example.com", name: "Private owner" },
    refresh: async () => {
      refreshed++;
      return session.info;
    },
    signOut: async () => {},
  };
  const before = Object.getOwnPropertyDescriptors(account),
    restore = bindAccount(account, session);
  function nativeHelper() {
    const body = JSON.stringify({ token: account.token });
    nativeRequests++;
    return body;
  }
  assert.ok(account.token);
  assert.throws(nativeHelper, /Bridge settings/);
  assert.throws(() => String(account.token), /Bridge settings/);
  assert.throws(() => {
    account.token = "injected";
  }, /Bridge settings/);
  assert.equal(nativeRequests, 0);
  await account.getUserInfo();
  assert.equal(refreshed, 1);
  account.save();
  assert.throws(() => account.login("email", "password"), /Bridge settings/);
  session.authenticated = false;
  assert.equal(account.token, "");
  assert.equal(await account.getUserInfo(), null);
  restore();
  restore();
  assert.deepEqual(Object.getOwnPropertyDescriptors(account), before);
});

test("session uses only its fixed custom origin, device secret storage, expiry and local handle-independent real token", async () => {
  const token = "vs1_" + "a".repeat(64),
    secrets = new Map(),
    requests = [];
  let invalid = false,
    expired = 0;
  const storage = {
    getSecret: (key) => secrets.get(key),
    setSecret: (key, value) => secrets.set(key, value),
    deleteSecret: (key) => secrets.delete(key),
  };
  const request = async (options) => {
    requests.push(options);
    assert.ok(options.url.startsWith("https://private.example/"));
    return {
      status: 200,
      json: invalid
        ? { error: "Not logged in" }
        : options.url.endsWith("signin")
          ? { token, email: "owner@local.invalid", name: "Owner" }
          : { email: "owner@local.invalid", name: "Owner" },
    };
  };
  const session = new MobileSession(
    "https://private.example",
    request,
    storage,
    "bridge-session-test",
    () => expired++,
  );
  await session.login("owner@local.invalid", "synthetic-password");
  assert.equal(session.token(), token);
  const saved = storage.getSecret("bridge-session-test");
  assert.equal(saved.includes("synthetic-password"), false);
  const restored = new MobileSession(
    "https://private.example",
    request,
    storage,
    "bridge-session-test",
  );
  assert.equal(await restored.restore(), true);
  const other = new MobileSession(
    "https://other.example",
    request,
    storage,
    "bridge-session-test",
  );
  assert.equal(await other.restore(), false);
  await assert.rejects(
    session.call("https://api.obsidian.md/user/info"),
    /Unsupported/,
  );
  invalid = true;
  await assert.rejects(session.refresh(), SessionExpired);
  assert.equal(session.authenticated, false);
  assert.equal(secrets.size, 0);
  assert.equal(expired, 1);
  assert.equal(
    requests.some((r) => r.url.includes("obsidian.md")),
    false,
  );
});

test("preparation deletes only a verified empty account record and refuses all existing account/connection states", () => {
  let value = JSON.stringify({ token: "", email: "", name: "", license: "" }),
    removed = 0;
  const storage = {
    getItem: () => value,
    removeItem: () => {
      removed++;
      value = null;
    },
  };
  const native = { vaultId: null, server: null };
  const app = {
    internalPlugins: { getPluginById: () => ({ instance: native }) },
  };
  assert.equal(prepareEmptyNativeAccount(app, storage), true);
  assert.equal(removed, 1);
  for (const record of [
    { token: "official-secret" },
    { key: "license-secret" },
    { email: "owner@example.com" },
    { unknown: "" },
  ]) {
    value = JSON.stringify(record);
    assert.throws(
      () => prepareEmptyNativeAccount(app, storage),
      /Nothing was changed/,
    );
    assert.equal(value, JSON.stringify(record));
  }
  value = JSON.stringify({ token: "" });
  native.vaultId = "existing-remote";
  assert.throws(
    () => prepareEmptyNativeAccount(app, storage),
    /remain unchanged/,
  );
  assert.equal(removed, 1);
});

test("stopping a controller during a pending health check cannot install native hooks later", async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const controller = new IOSController(
    {},
    { server: "https://private.example" },
    () => {},
    async () => {},
  );
  controller.testServer = () => pending;
  controller.getNative = () => {
    throw Error("Must not reach native state after stop");
  };
  const login = controller.establish("test@example.com", "synthetic");
  await controller.stop();
  resolve("https://private.example");
  await assert.rejects(login, /cancelled/);
  assert.equal(controller.session, null);
  assert.equal(controller.restoreAccount, null);
});

test("a secret-storage write failure revokes the newly created custom token and clears memory", async () => {
  const requests = [],
    token = "vs1_" + "b".repeat(64);
  const session = new MobileSession(
    "https://private.example",
    async (options) => {
      requests.push(new URL(options.url).pathname);
      return {
        status: 200,
        json: options.url.endsWith("signin") ? { token } : {},
      };
    },
    {
      setSecret() {
        throw Error("Unavailable");
      },
    },
    "test",
  );
  await assert.rejects(
    session.login("test@example.com", "synthetic"),
    /secret store/,
  );
  assert.equal(session.authenticated, false);
  assert.equal(requests.at(-1), "/user/signout");
});

test("mobile transport overrides restore replaced instances and preserve another owner's later method", () => {
  const { installDirectConnection } = require("../src/ios-connection.cjs");
  class Transport { connect() {} }
  const first = new Transport(), second = new Transport();
  const native = { server: first };
  const before = Object.getOwnPropertyDescriptor(native, "server");
  const restore = installDirectConnection(native, {});
  assert.notEqual(first.connect, Transport.prototype.connect);
  native.server = second;
  assert.equal(first.connect, Transport.prototype.connect);
  assert.notEqual(second.connect, Transport.prototype.connect);
  const laterOwner = () => {};
  second.connect = laterOwner;
  restore();
  restore();
  assert.equal(second.connect, laterOwner);
  assert.deepEqual(Object.getOwnPropertyDescriptor(native, "server"), { ...before, value: second });
  assert.equal(Object.hasOwn(first, "connect"), false);
});
