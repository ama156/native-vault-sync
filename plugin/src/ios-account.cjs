"use strict";
// Version-specific, opt-in research adapter. No original client code is bundled.
const IOS_1151 = Object.freeze({
  asyncGetServer:
    "7232a5cf37b4297b29a084bc093a74aa5689805913c556833a719c78a0b245ae",
  accountClass:
    "c60a2c848b6a3fa9680b2261ab93ce8974274612b9aab7b0c3db9b0cafba0e47",
  setSyncType:
    "c6adce9f9645e0bfff5f99c53a70d5385e98b21e9cb8796830427651e607569d",
  setup: "ae564be66f7f14f6ee6fe4ffa22ce3004a4dcde0a34a89132517b7918cf42265",
  transportClass:
    "fd5244553a30877798e96b8090eaaae0d80e978df2d2d236a8fd498833eb1fc9",
});

async function fingerprint(fn) {
  if (typeof fn !== "function" || !globalThis.crypto?.subtle)
    throw Error("Required runtime fingerprint support is unavailable.");
  const bytes = new TextEncoder().encode(Function.prototype.toString.call(fn));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function captureFreshAccount(native, expected = IOS_1151) {
  const acquire = native?.asyncGetServer;
  if ((await fingerprint(acquire)) !== expected.asyncGetServer)
    throw Error(
      "Unqualified iOS native connection method. Sync remains inactive.",
    );
  const prototype = Object.prototype;
  if (!Object.isExtensible(prototype) || Object.hasOwn(prototype, "token"))
    throw Error("The temporary account probe cannot be installed safely.");
  let account = null;
  let pending;
  const getter = function () {
    if (account && account !== this)
      throw Error("Unexpected account probe access.");
    account = this;
    return undefined;
  };
  try {
    Object.defineProperty(prototype, "token", {
      configurable: true,
      enumerable: false,
      get: getter,
    });
    // The exact fingerprinted method returns at its account gate. This inert
    // receiver has no vault, key, backoff, file methods or network operations.
    // There is deliberately no await/callback/event-loop turn inside the probe.
    pending = Reflect.apply(
      acquire,
      {
        server: null,
        encryptionProvider: {},
        host: "account-probe-only",
        vaultId: null,
      },
      [],
    );
  } finally {
    // Restore before settling the async function, including all thrown cases.
    if (Object.getOwnPropertyDescriptor(prototype, "token")?.get === getter)
      delete prototype.token;
  }
  if ((await pending) !== null || !account)
    throw Error(
      "A fresh native account is required. Existing and saved signed-out accounts are left unchanged.",
    );
  const own = Object.getOwnPropertyDescriptors(account);
  if (
    Object.keys(own).sort().join(",") !==
      "company,expiry,keyValidation,seats" ||
    !Object.isExtensible(account) ||
    own.company.value !== "" ||
    own.keyValidation.value !== "" ||
    own.expiry.value !== 0 ||
    own.seats.value !== 0
  )
    throw Error(
      "The account is not an unused native account. No changes were made.",
    );
  const ctor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(account),
    "constructor",
  )?.value;
  if ((await fingerprint(ctor)) !== expected.accountClass)
    throw Error("Unqualified native account class. No changes were made.");
  return account;
}

function bindAccount(account, session) {
  const before = Object.getOwnPropertyDescriptors(account);
  const owned = new Map();
  const blocked = () => {
    throw Error(
      "Use Vault Sync Bridge settings for this custom account operation.",
    );
  };
  // A local session handle satisfies native presence checks. It is NOT a server
  // token. Real credentials remain in session and can only leave via our client.
  // Crucially, native helpers cannot serialize/coerce this handle into a request:
  // JSON.stringify throws BEFORE their captured fetch is invoked.
  const handle = Object.freeze({
    toJSON: blocked,
    toString: blocked,
    [Symbol.toPrimitive]: blocked,
  });
  function define(name, descriptor) {
    Object.defineProperty(account, name, {
      configurable: true,
      enumerable: false,
      ...descriptor,
    });
    owned.set(name, Object.getOwnPropertyDescriptor(account, name));
  }
  const info = (name) => () => session.info?.[name] || "";
  try {
    define("token", {
      get: () => (session.authenticated ? handle : ""),
      set: blocked,
    });
    for (const name of ["email", "name", "license"])
      define(name, { get: info(name), set: blocked });
    define("key", { get: () => null, set: blocked });
    define("save", { value: () => {}, writable: false });
    define("getUserInfo", {
      value: () =>
        session.authenticated ? session.refresh() : Promise.resolve(null),
      writable: false,
    });
    define("logout", { value: () => session.signOut(), writable: false });
    define("login", { value: blocked, writable: false });
    define("loginWithAuthToken", { value: blocked, writable: false });
    define("setKey", { value: blocked, writable: false });
    define("checkBizKey", { value: () => Promise.resolve(), writable: false });
  } catch (error) {
    for (const name of owned.keys()) {
      if (before[name]) Object.defineProperty(account, name, before[name]);
      else delete account[name];
    }
    throw error;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, descriptor] of owned) {
      const current = Object.getOwnPropertyDescriptor(account, name);
      if (
        current?.get === descriptor.get &&
        current?.set === descriptor.set &&
        current?.value === descriptor.value
      ) {
        if (before[name]) Object.defineProperty(account, name, before[name]);
        else delete account[name];
      }
    }
  };
}

module.exports = { IOS_1151, fingerprint, captureFreshAccount, bindAccount };
