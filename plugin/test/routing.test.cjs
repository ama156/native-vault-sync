const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const { EventEmitter } = require("node:events");
const { AccountRouter } = require("../src/account-router.cjs");
const {
  connectLoopback,
  installBootstrap,
} = require("../src/connection-bootstrap.cjs");
class Debugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.commands = [];
  }
  isAttached() {
    return this.attached;
  }
  attach() {
    if (this.attached) throw Error("Already attached");
    this.attached = true;
  }
  detach() {
    this.attached = false;
    this.emit("detach", {}, "canceled_by_user");
  }
  async sendCommand(method, params) {
    this.commands.push({ method, params });
    return {};
  }
}
class Contents extends EventEmitter {
  constructor(id, session) {
    super();
    this.id = id;
    this.session = session;
    this.debugger = new Debugger();
    this.destroyed = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
}
function coordinator(contents) {
  const app = new EventEmitter(),
    module = { exports: {} };
  const electron = {
    app,
    webContents: {
      fromId: (id) => contents.find((c) => c.id === id && !c.destroyed),
      getAllWebContents: () => contents.filter((c) => !c.destroyed),
    },
  };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: (name) =>
      name === "electron"
        ? electron
        : name === "./account-router.cjs"
          ? { AccountRouter }
          : require(name),
    Map,
    Symbol,
    Promise,
    globalThis: {},
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../src/main-coordinator.cjs"),
      "utf8",
    ),
    context,
  );
  return { manager: module.exports, app };
}
test("account routing changes only the destination; unsupported operations are blocked", async () => {
  const c = new Contents(1, {}),
    r = new AccountRouter(c, "https://private.example");
  await r.start();
  const request = {
    url: "https://api.obsidian.md/user/signin",
    method: "POST",
    postData: "never logged",
  };
  c.debugger.emit("message", {}, "Fetch.requestPaused", {
    requestId: "1",
    request,
  });
  assert.deepEqual(c.debugger.commands.at(-1), {
    method: "Fetch.continueRequest",
    params: { requestId: "1", url: "https://private.example/user/signin" },
  });
  assert.equal(request.postData, "never logged");
  c.debugger.emit("message", {}, "Fetch.requestPaused", {
    requestId: "2",
    request: { url: "https://api.obsidian.md/publish/list", method: "POST" },
  });
  assert.equal(c.debugger.commands.at(-1).method, "Fetch.failRequest");
  await r.stop();
  assert.equal(c.debugger.listenerCount("message"), 0);
  assert.equal(c.debugger.isAttached(), false);
});
test("one coordinator covers Settings windows, shares same-server leases, rejects conflicts, and cleans up", async () => {
  const session = {},
    a = new Contents(1, session),
    b = new Contents(2, session),
    contents = [a, b];
  const { manager, app } = coordinator(contents);
  const first = await manager.acquire(1, "https://private.example", () => {}),
    second = await manager.acquire(2, "https://private.example", () => {});
  await assert.rejects(
    manager.acquire(2, "https://other.example", () => {}),
    /different custom server/,
  );
  const settings = new Contents(3, session);
  contents.push(settings);
  app.emit("web-contents-created", {}, settings);
  await new Promise(setImmediate);
  assert.equal(settings.debugger.isAttached(), true);
  await manager.release(first);
  assert.equal(a.debugger.isAttached(), true);
  await manager.release(second);
  for (const c of contents) assert.equal(c.debugger.isAttached(), false);
  assert.equal(app.listenerCount("web-contents-created"), 0);
});
test("an existing external debugger is never detached or stolen", async () => {
  const a = new Contents(1, {});
  a.debugger.attach();
  const { manager } = coordinator([a]);
  await assert.rejects(
    manager.acquire(1, "https://private.example", () => {}),
    /existing debugger/,
  );
  assert.equal(a.debugger.isAttached(), true);
});
test("connection bootstrap preserves native handlers and is fully reversible", async () => {
  let socket;
  class Socket {
    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen());
    }
    close() {}
  }
  const old = global.window;
  global.window = { WebSocket: Socket, setInterval, clearInterval };
  try {
    const native = { server: null };
    const restore = installBootstrap(native, "ws://127.0.0.1:12345/capability");
    let calls = 0;
    const original = () => {
      throw Error("Original guard must not run for this adapter");
    };
    const transport = {
      socket: null,
      encryptionProvider: { keyHash: "opaque", encryptionVersion: 3 },
      hasConnection() {
        return !!this.socket;
      },
      connect: original,
      disconnect() {
        this.socket?.close();
        this.socket = null;
        clearInterval(this.heartbeat);
      },
      send(message) {
        this.sent = message;
      },
      onMessage() {
        calls++;
      },
    };
    native.server = transport;
    const pending = transport.connect(
      "ignored",
      "token",
      "vault",
      7,
      false,
      "device",
      () => {},
      () => {},
    );
    await Promise.resolve();
    assert.equal(transport.sent.op, "init");
    assert.equal(transport.sent.encryption_version, 3);
    socket.onmessage({
      data: JSON.stringify({ res: "ok", userId: 1, perFileMax: 42 }),
    });
    await pending;
    socket.onmessage({ data: '{"op":"ready","version":7}' });
    assert.equal(calls, 1);
    assert.equal(transport.perFileMax, 42);
    transport.disconnect();
    restore();
    assert.equal(transport.connect, original);
    assert.equal(
      Object.getOwnPropertyDescriptor(native, "server").value,
      transport,
    );
  } finally {
    global.window = old;
  }
});
