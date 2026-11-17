"use strict";
// Independently written connection adapter for versions that reject loopback.
// All post-login operations and encryption remain the native transport's methods.
function connectLoopback(localURL) {
  return function (
    _requestedURL,
    token,
    id,
    version,
    initial,
    device,
    onReady,
    onPush,
  ) {
    if (this.hasConnection()) return Promise.resolve();
    const transport = this;
    transport.onReady = onReady;
    transport.onPush = onPush;
    return new Promise((resolve, reject) => {
      let authenticated = false,
        finished = false;
      const socket = new window.WebSocket(localURL);
      transport.socket = socket;
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(
        () => fail(new Error("Unable to connect to the local bridge.")),
        120000,
      );
      function fail(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        transport.disconnect();
        reject(error);
      }
      socket.onerror = () =>
        fail(new Error("The local bridge connection failed."));
      socket.onclose = () => fail(new Error("The local bridge disconnected."));
      socket.onopen = () => {
        transport.lastMessageTs = Date.now();
        transport.heartbeat = window.setInterval(() => {
          const idle = Date.now() - transport.lastMessageTs;
          if (idle > 120000) transport.disconnect();
          else if (idle > 10000) transport.send({ op: "ping" });
        }, 20000);
        transport.send({
          op: "init",
          token,
          id,
          keyhash: transport.encryptionProvider.keyHash,
          version,
          initial,
          device,
          encryption_version: transport.encryptionProvider.encryptionVersion,
        });
      };
      socket.onmessage = (event) => {
        if (authenticated) return;
        if (typeof event.data !== "string") {
          fail(new Error("Expected a JSON login reply."));
          return;
        }
        let response;
        try {
          response = JSON.parse(event.data);
        } catch {
          fail(new Error("Invalid bridge login reply."));
          return;
        }
        transport.lastMessageTs = Date.now();
        if (response.op === "pong") return;
        if (response.res !== "ok") {
          fail(
            new Error(
              "Failed to authenticate: " +
                (response.msg || "server rejected login"),
            ),
          );
          return;
        }
        if (Object.hasOwn(response, "perFileMax")) {
          if (
            !Number.isInteger(response.perFileMax) ||
            response.perFileMax < 0
          ) {
            fail(new Error("Invalid server file limit."));
            return;
          }
          transport.perFileMax = response.perFileMax;
        }
        if (response.userId) transport.userId = response.userId;
        authenticated = true;
        finished = true;
        clearTimeout(timer);
        socket.onmessage = transport.onMessage.bind(transport);
        socket.onclose = transport.disconnect.bind(transport);
        socket.onerror = transport.disconnect.bind(transport);
        socket.onopen = null;
        resolve();
      };
    });
  };
}
function installBootstrap(native, localURL) {
  const descriptor = Object.getOwnPropertyDescriptor(native, "server");
  if (!descriptor || !descriptor.configurable || !("value" in descriptor))
    throw new Error("Unsupported native transport property shape.");
  let server = descriptor.value,
    original = null;
  const adapt = (value) => {
    if (server && original) {
      server.connect = original;
      original = null;
    }
    server = value;
    if (server) {
      for (const method of [
        "connect",
        "disconnect",
        "hasConnection",
        "onMessage",
        "send",
      ])
        if (typeof server[method] !== "function")
          throw new Error("Unsupported native transport methods.");
      original = server.connect;
      server.connect = connectLoopback(localURL);
    }
  };
  Object.defineProperty(native, "server", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => server,
    set: adapt,
  });
  adapt(server);
  return () => {
    if (server && original) server.connect = original;
    Object.defineProperty(native, "server", { ...descriptor, value: server });
  };
}
module.exports = { installBootstrap, connectLoopback };
