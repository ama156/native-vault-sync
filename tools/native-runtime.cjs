// Development only: execute selected functions from an explicitly supplied,
// disposable client copy. No proprietary implementation is distributed here.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  vm = require("node:vm"),
  acorn = require("acorn"),
  tslib = require("tslib");
function entry(archive, name) {
  const fd = fs.openSync(archive, "r");
  try {
    const h = Buffer.alloc(16);
    fs.readSync(fd, h, 0, 16, 0);
    const size = h.readUInt32LE(12);
    if (size > 64 << 20) throw Error("Invalid ASAR");
    const b = Buffer.alloc(size);
    fs.readSync(fd, b, 0, size, 16);
    let node = JSON.parse(b.toString());
    for (const part of name.split("/")) node = node.files?.[part];
    if (!node || node.unpacked || node.size > 64 << 20)
      throw Error("Missing ASAR entry");
    const content = Buffer.alloc(node.size);
    fs.readSync(
      fd,
      content,
      0,
      node.size,
      8 + h.readUInt32LE(4) + Number(node.offset),
    );
    return content.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function source(archive) {
  const resolved = fs.realpathSync(archive);
  if (
    resolved.startsWith("/Applications/") ||
    resolved.includes("/Library/Application Support/obsidian/")
  )
    throw Error(
      "Tests require a separate sandbox copy, never the installed client/profile",
    );
  const text = entry(resolved, "app.js"),
    version = JSON.parse(entry(resolved, "package.json")).version;
  return {
    text,
    version,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}
class Queue {
  constructor() {
    this.tail = Promise.resolve();
  }
  queue(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
// Browser WebSocket dispatches each message as a separate task. Node ws can
// emit multiple messages synchronously from one TCP packet; preserve browser
// task delivery so the old transport can install its next binary waiter.
class BrowserTaskWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.ws = new (require("ws"))(url);
    this.messages = [];
    this.delivering = false;
    this.binaryType = "arraybuffer";
    this.ws.on("open", () => setImmediate(() => this.onopen?.()));
    this.ws.on("close", (code, reason) =>
      setImmediate(() => this.onclose?.({ code, reason: String(reason) })),
    );
    this.ws.on("error", (error) => setImmediate(() => this.onerror?.(error)));
    this.ws.on("message", (data, binary) => {
      this.messages.push({
        data: binary ? Uint8Array.from(data).buffer : data.toString(),
      });
      this.deliver();
    });
  }
  get readyState() {
    return this.ws.readyState;
  }
  deliver() {
    if (this.delivering) return;
    this.delivering = true;
    const next = () =>
      setImmediate(() => {
        const m = this.messages.shift();
        if (m) this.onmessage?.(m);
        if (this.messages.length) next();
        else this.delivering = false;
      });
    next();
  }
  send(data) {
    this.ws.send(data);
  }
  close() {
    this.ws.close();
  }
}
function load187(archive) {
  const data = source(archive);
  if (
    data.version !== "1.8.7" ||
    data.sha256 !==
      "fc1b1bede214e0f28266ce356b43c2aa36329a3b3cb47160f3a086110a03c9b5"
  )
    throw Error("Unqualified 1.8.7 sandbox source");
  const variables = new Map(),
    functions = new Map();
  const ast = acorn.parse(data.text, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
  });
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
      variables.set(node.id.name, node);
    if (node.type === "FunctionDeclaration" && node.id)
      functions.set(node.id.name, node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  const codeFor = (n) => {
    const node = functions.get(n);
    if (!node) throw Error("Missing function " + n);
    return data.text.slice(node.start, node.end);
  };
  const transport = variables.get("s0");
  const context = vm.createContext({
    g: tslib.__awaiter,
    y: tslib.__generator,
    f: tslib.__extends,
    uL: Queue,
    hL: deferred,
    Q1: BrowserTaskWebSocket,
    J1: URL,
    e0: Object.getOwnPropertyDescriptor(URL.prototype, "hostname").get,
    t0: String.prototype.endsWith,
    X1: {},
    window: {
      setInterval,
      setTimeout,
      clearInterval,
      clearTimeout,
      crypto: crypto.webcrypto,
      require: (n) => {
        if (n === "crypto") return crypto;
        throw Error("Unexpected native dependency");
      },
    },
    setInterval,
    setTimeout,
    clearInterval,
    clearTimeout,
    localStorage: { getItem: () => null },
    console,
    crypto: crypto.webcrypto,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    Buffer,
  });
  const code =
    ["Qc", "Kc", "uf", "su", "hf", "df", "bf", "yf", "gf", "vW", "gW", "yW"]
      .map(codeFor)
      .join("\n") +
    '\nvar mW="AES-GCM";var ' +
    data.text.slice(variables.get("bW").start, variables.get("HW").end) +
    ";var " +
    data.text.slice(transport.start, transport.end) +
    ";({Transport:s0,provider:BW,derive:OW})";
  return {
    ...new vm.Script(code).runInContext(context, { timeout: 5000 }),
    version: data.version,
    sha256: data.sha256,
  };
}
module.exports = { entry, source, load187 };
