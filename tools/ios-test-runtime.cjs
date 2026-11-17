"use strict";
// Private-source development harness; never used by the installed plugin.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  vm = require("node:vm");
const { EventEmitter } = require("node:events");
const acorn = require("acorn"),
  esbuild = require("esbuild");
const { WebSocket } = require("ws");
const HASH = "ffd620f9ee985cc4eb93ab25ba5871a33c9460b68035f2d74c8d4ddc2d43ef91";
let cached;
function readSource(file) {
  const resolved = fs.realpathSync(file);
  if (resolved.startsWith("/Applications/"))
    throw Error("Installed app paths are excluded.");
  const source = fs.readFileSync(resolved, "utf8");
  if (crypto.createHash("sha256").update(source).digest("hex") !== HASH)
    throw Error("Unqualified iOS source.");
  if (cached) return cached;
  const ast = acorn.parse(source, { ecmaVersion: "latest" });
  const bindings = new Map();
  for (const node of ast.body[0].expression.callee.body.body) {
    if (node.type === "VariableDeclaration")
      for (const declaration of node.declarations)
        if (declaration.id.type === "Identifier")
          bindings.set(declaration.id.name, declaration);
    if (node.type === "FunctionDeclaration") bindings.set(node.id.name, node);
  }
  const slice = (node) => source.slice(node.start, node.end);
  const external = new Set([
    "hi",
    "K",
    "Sl",
    "S",
    "Ei",
    "G",
    "Ie",
    "Ci",
    "O",
    "HW",
    "Hw",
    "bo",
    "T6e",
    "Si",
    "TD",
    "be",
    "$P",
    "Dj",
  ]);
  const emitted = new Set(),
    chunks = [];
  const staticValues = new Map();
  function inspectStatic(node) {
    if (node?.type === "SequenceExpression")
      return node.expressions.forEach(inspectStatic);
    if (
      node?.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "MemberExpression" ||
      node.left.computed ||
      node.left.object.type !== "Identifier" ||
      node.right.type !== "Literal"
    )
      return;
    const name = node.left.object.name;
    if (!staticValues.has(name)) staticValues.set(name, []);
    staticValues.get(name).push(slice(node) + ";");
  }
  for (const node of ast.body[0].expression.callee.body.body)
    if (node.type === "ExpressionStatement") inspectStatic(node.expression);
  function deps(node) {
    const local = new Set(),
      refs = new Set();
    function bind(pattern) {
      if (!pattern) return;
      if (pattern.type === "Identifier") local.add(pattern.name);
      else if (pattern.type === "RestElement") bind(pattern.argument);
      else if (pattern.type === "AssignmentPattern") bind(pattern.left);
      else if (pattern.type === "ArrayPattern") pattern.elements.forEach(bind);
      else if (pattern.type === "ObjectPattern")
        pattern.properties.forEach((p) => bind(p.value || p.argument));
    }
    function walk(n, parent, key) {
      if (!n || typeof n !== "object") return;
      if (/Function/.test(n.type) || n.type === "ArrowFunctionExpression") {
        if (n.id) bind(n.id);
        n.params?.forEach(bind);
      }
      if (n.type === "VariableDeclarator") bind(n.id);
      if (n.type === "CatchClause") bind(n.param);
      if (
        n.type === "Identifier" &&
        !(
          parent?.type === "MemberExpression" &&
          key === "property" &&
          !parent.computed
        ) &&
        !(
          (parent?.type === "Property" ||
            parent?.type === "MethodDefinition") &&
          key === "key" &&
          !parent.computed
        )
      )
        refs.add(n.name);
      for (const [k, value] of Object.entries(n)) {
        if (Array.isArray(value)) value.forEach((child) => walk(child, n, k));
        else if (value && typeof value === "object") walk(value, n, k);
      }
    }
    walk(node);
    return [...refs].filter(
      (name) => !local.has(name) && bindings.has(name) && !external.has(name),
    );
  }
  function emit(name) {
    if (emitted.has(name) || external.has(name)) return;
    const declaration = bindings.get(name);
    if (!declaration) throw Error("Missing private dependency: " + name);
    emitted.add(name);
    for (const dependency of deps(
      declaration.type === "VariableDeclarator"
        ? declaration.init
        : declaration,
    ))
      if (dependency !== name) emit(dependency);
    chunks.push(
      declaration.type === "VariableDeclarator"
        ? "var " + slice(declaration) + ";"
        : slice(declaration),
    );
    chunks.push(...(staticValues.get(name) || []));
  }
  for (const name of [
    "C4",
    "iJ",
    "SD",
    "MD",
    "Ys",
    "sr",
    "nj",
    "aj",
    "oj",
    "ij",
    "Hs",
    "_P",
    "Xq",
    "xD",
  ])
    emit(name);
  const engine = bindings.get("TD").init;
  const selected = new Set([
    "setup",
    "unsetup",
    "clear",
    "saveData",
    "_sync",
    "asyncGetServer",
    "onPushedFile",
    "scanFiles",
    "syncFileDown",
    "getHashFromMetadataCache",
    "onFileAdd",
    "onFileRemove",
    "onFileRename",
    "setDirty",
    "forceSaveData",
    "logTags",
  ]);
  for (const method of engine.body.body)
    if (selected.has(method.key?.name))
      for (const dependency of deps(method.value)) emit(dependency);
  cached = {
    chunks: chunks.join("\n"),
    engine: slice(engine),
    account: slice(bindings.get("$P").init),
    dependencies: [...emitted],
  };
  return cached;
}

function createRuntime(file, options = {}) {
  const source = readSource(file);
  const traces = [];
  const nativeStorage = new Map(
    options.nativeAccount === undefined
      ? []
      : [["obsidian-account", JSON.stringify(options.nativeAccount)]],
  );
  class Socket extends WebSocket {
    constructor(url) {
      super(url, { origin: "capacitor://localhost" });
      traces.push({ kind: "socket", origin: new URL(url).origin });
    }
  }
  class File {
    constructor(name, data) {
      this.path = name;
      this.extension = name.split(".").pop();
      this.stat = {
        ctime: Date.now(),
        mtime: Date.now(),
        size: data.byteLength,
      };
      this.data = data;
    }
  }
  class Folder {
    constructor(name) {
      this.path = name;
      this.children = [];
    }
  }
  const context = vm.createContext({
    crypto: crypto.webcrypto,
    TextEncoder,
    TextDecoder,
    Buffer,
    URL,
    WebSocket: Socket,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    navigator: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)",
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    FixtureEvents: EventEmitter,
    G: File,
    Ie: Folder,
    Ci: class Unreadable {},
    Ei: class FileSystemAdapter {},
    S: {
      isIosApp: true,
      isMobileApp: true,
      isMobile: true,
      isDesktopApp: false,
      isAndroidApp: false,
    },
    Sl: new Proxy({}, { get: (_, name) => () => String(name) }),
    O: class Notice {},
    T6e: false,
    Si: false,
    K: () => {
      const fn = () => {};
      fn.cancel = () => {};
      return fn;
    },
    // Native account HTTP must never reach any real destination in this harness.
    fetch: async (url) => {
      traces.push({
        kind: "native-account-fetch",
        origin: new URL(url).origin,
      });
      throw Error("Native account request escaped the guard");
    },
    localStorage: {
      getItem: (key) => nativeStorage.get(key) ?? null,
      setItem: (key, value) => nativeStorage.set(key, value),
    },
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(
    "globalThis.window=globalThis;window.require=(name)=>{if(name!=='crypto')throw Error('Unexpected dependency');return nodeCrypto;};Array.prototype.last=function(){return this[this.length-1]};Array.prototype.contains=function(x){return this.includes(x)};String.prototype.contains=function(x){return this.includes(x)};var hi=class extends FixtureEvents{trigger(...args){return this.emit(...args)}};var Qq='';",
    Object.assign(context, { nodeCrypto: crypto }),
  );
  const api = vm.runInContext(
    "(()=>{" +
      source.chunks +
      ";var Dj='obsidian-account',$P=" +
      source.account +
      ",be=new $P;var TD=" +
      source.engine +
      ";return {create:()=>new TD(),createFilter:(configDir)=>new xD(configDir),derive:C4,provider:iJ,nativeAccountCall:(route)=>sr(route,{token:be.token}),accountSnapshot:()=>JSON.stringify(Object.keys(be).sort()),};})()",
    context,
    { timeout: 10000 },
  );
  const bundle = esbuild.buildSync({
    stdin: {
      contents:
        'module.exports={...require("./ios-account.cjs"),...require("./mobile-session.cjs"),...require("./ios-connection.cjs"),...require("./ios-controller.cjs")};',
      resolveDir: path.resolve(__dirname, "../plugin/src"),
    },
    bundle: true,
    platform: "browser",
    format: "cjs",
    write: false,
  }).outputFiles[0].text;
  context.module = { exports: {} };
  vm.runInContext(bundle, context);
  const bridge = context.module.exports;
  function createEngine() {
    const native = api.create(),
      root = new Folder("/"),
      files = new Map();
    const toBuffer = (value) =>
      typeof value === "string"
        ? new TextEncoder().encode(value).buffer
        : value;
    const write = async (name, value, times = {}) => {
      const data = toBuffer(value);
      let file = files.get(name);
      if (!file) {
        file = new File(name, data);
        files.set(name, file);
        root.children.push(file);
      }
      file.data = data;
      file.stat = {
        ctime: times.ctime || file.stat.ctime,
        mtime: times.mtime || Date.now(),
        size: data.byteLength,
      };
      native.onFileAdd(file);
      return file;
    };
    const adapter = {
      promise: Promise.resolve(),
      exists: async (name) => files.has(name),
      stat: async (name) =>
        files.has(name) ? { type: "file", ...files.get(name).stat } : null,
      readBinary: async (name) => files.get(name).data,
      read: async (name) => new TextDecoder().decode(files.get(name).data),
      writeBinary: write,
      write,
      list: async () => ({ files: [], folders: [] }),
      remove: async (name) => {
        const file = files.get(name);
        files.delete(name);
        root.children = root.children.filter((f) => f !== file);
        native.onFileRemove(file);
      },
    };
    const vault = {
      adapter,
      configDir: ".obsidian",
      getRoot: () => root,
      getAbstractFileByPath: (name) => files.get(name),
      read: async (file) => adapter.read(file.path),
      create: write,
      createBinary: write,
      modify: async (file, data, times) => write(file.path, data, times),
      modifyBinary: async (file, data, times) => write(file.path, data, times),
      delete: async (file) => adapter.remove(file.path),
    };
    native.app = {
      appId: "disposable-ios-proof",
      vault,
      metadataCache: { getFileInfo: () => null },
      fileManager: { storeTextFileBackup() {} },
    };
    native.vault = vault;
    native.plugin = { enabled: true };
    native.db = { put: async () => {} };
    native.filter = api.createFilter(vault.configDir);
    native.deviceName = "Disposable iOS source harness";
    native.requestSync = () => {};
    native.initialized = native.dataLoaded = true;
    return { native, vault, files, write };
  }
  return {
    ...api,
    bridge,
    createEngine,
    context,
    traces,
    nativeStorage,
    sourceHash: HASH,
    dependencyCount: source.dependencies.length,
  };
}
module.exports = { createRuntime, readSource };
