"use strict";
const { IOS_1151, fingerprint } = require("./ios-account.cjs");

function installDirectConnection(native, session, expected = IOS_1151) {
  const descriptor = Object.getOwnPropertyDescriptor(native, "server");
  if (!descriptor?.configurable || !Object.hasOwn(descriptor, "value"))
    throw Error("Unsupported native transport property.");
  let current = descriptor.value;
  const methods = new Map();
  let restored = false;
  function restoreMethod(transport) {
    const saved = methods.get(transport);
    if (!saved) return;
    if (transport.connect === saved.override) {
      if (saved.original)
        Object.defineProperty(transport, "connect", saved.original);
      else delete transport.connect;
    }
    methods.delete(transport);
  }
  function adapt(transport) {
    if (current !== transport) restoreMethod(current);
    current = transport;
    if (!transport || methods.has(transport)) return;
    const original = Object.getOwnPropertyDescriptor(transport, "connect");
    const originalConnect = transport.connect;
    const override = async function (
      _host,
      _nativeHandle,
      id,
      version,
      initial,
      device,
      onReady,
      onPush,
    ) {
      if ((await fingerprint(this.constructor)) !== expected.transportClass)
        throw Error("Unsupported native transport implementation.");
      if (this.hasConnection()) return;
      const transport = this;
      const provider = this.encryptionProvider;
      // Preflight exact native encryption identity before sending a socket init.
      await session.call("/vault/access", {
        vault_uid: id,
        keyhash: provider.keyHash,
        encryption_version: provider.encryptionVersion,
        host: new URL(session.server).host + "/sync",
      });
      if (restored || current !== transport)
        throw Error("Direct Sync connection cancelled.");
      if (this.hasConnection()) return;
      const token = session.token();
      this.onReady = onReady;
      this.onPush = onPush;
      await new Promise((resolve, reject) => {
        let accepted = false,
          settled = false;
        const socket = new globalThis.WebSocket(
          session.server.replace(/^http/, "ws") + "/sync",
        );
        transport.socket = socket;
        socket.binaryType = "arraybuffer";
        const timer = setTimeout(
          () => fail("Custom Sync connection timed out."),
          30000,
        );
        function fail(message) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          transport.disconnect();
          reject(Error(message));
        }
        socket.onerror = () => fail("Custom Sync connection unavailable.");
        socket.onclose = () => fail("Custom Sync connection closed.");
        socket.onopen = () => {
          transport.lastMessageTs = Date.now();
          transport.heartbeat = setInterval(() => {
            const idle = Date.now() - transport.lastMessageTs;
            if (idle > 120000) transport.disconnect();
            else if (idle > 10000) transport.send({ op: "ping" });
          }, 20000);
          transport.send({
            op: "init",
            token,
            id,
            keyhash: provider.keyHash,
            version,
            initial,
            device,
            encryption_version: provider.encryptionVersion,
          });
        };
        const receive = (event) => {
          if (typeof event.data === "string") {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch {
              fail("Invalid custom Sync response.");
              return;
            }
            if (
              message.res === "err" &&
              (message.msg === "Not logged in" ||
                message.err === "Not logged in")
            ) {
              session.invalidate();
              transport.disconnect();
              fail("Custom session expired. Sign in again.");
              return;
            }
            if (!accepted) {
              if (message.op === "pong") return;
              if (message.res !== "ok") {
                fail(
                  "Custom Sync login rejected. Check the vault password and account session.",
                );
                return;
              }
              if (
                !Number.isInteger(message.perFileMax) ||
                message.perFileMax < 0
              ) {
                fail("Invalid custom Sync file limit.");
                return;
              }
              transport.perFileMax = message.perFileMax;
              transport.userId = message.userId;
              accepted = true;
              settled = true;
              clearTimeout(timer);
              socket.onclose = transport.disconnect.bind(transport);
              socket.onerror = transport.disconnect.bind(transport);
              socket.onopen = null;
              resolve();
              return;
            }
          } else if (!accepted) {
            fail("Expected custom Sync login JSON.");
            return;
          }
          transport.onMessage(event);
        };
        socket.onmessage = receive;
      });
    };
    Object.defineProperty(transport, "connect", {
      configurable: true,
      writable: true,
      value: override,
    });
    methods.set(transport, { original, originalConnect, override });
  }
  const getter = () => current;
  Object.defineProperty(native, "server", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: getter,
    set: adapt,
  });
  try {
    adapt(current);
  } catch (error) {
    Object.defineProperty(native, "server", descriptor);
    throw error;
  }
  return () => {
    if (restored) return;
    restored = true;
    for (const transport of [...methods.keys()]) restoreMethod(transport);
    if (Object.getOwnPropertyDescriptor(native, "server")?.get === getter)
      Object.defineProperty(native, "server", {
        ...descriptor,
        value: current,
      });
    methods.clear();
  };
}
module.exports = { installDirectConnection };
