"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const esbuild = require("esbuild");
const { compatibility } = require("../src/compatibility.cjs");
const { collectReport } = require("../src/mobile-report.cjs");

const root = path.resolve(__dirname, "../..");
const entry = path.join(root, "plugin/src/entry.cjs");
const sdkExternal = [
  "obsidian",
  "electron",
  "@electron/remote",
  "bufferutil",
  "utf-8-validate",
];

test("platform/version matrix separates qualified desktop support from opt-in unqualified iOS support", () => {
  for (const os of ["isMacOS", "isWin", "isLinux"]) {
    const platform = { isDesktopApp: true, [os]: true };
    assert.equal(compatibility(platform, "1.15.1").adapter, "desktop");
    assert.equal(compatibility(platform, "1.8.7").syncAdapterAvailable, true);
    assert.equal(compatibility(platform, "9.9.9").syncAdapterAvailable, false);
  }
  for (const platform of [
    { isIosApp: true },
    { isAndroidApp: true },
    { isMobile: true },
    {},
  ]) {
    const status = compatibility(platform, "1.15.1");
    assert.equal(status.adapter, "mobile-diagnostics");
    assert.equal(status.syncAdapterAvailable, false);
    assert.equal(status.qualification, "unqualified");
  }
  assert.equal(
    compatibility({ isDesktopApp: true, isWin: true }, "1.15.1").qualification,
    "unqualified",
  );
  // Device identity wins if a host supplies contradictory desktop flags.
  assert.equal(
    compatibility({ isDesktopApp: true, isIosApp: true }, "1.15.1").adapter,
    "mobile-diagnostics",
  );
});

function fixture() {
  const forbidden = () => {
    throw Error("Native operation must not be invoked");
  };
  const transport = Object.freeze({
    token: "SECRET-TOKEN",
    connect: forbidden,
    disconnect: forbidden,
    hasConnection: forbidden,
    onMessage: forbidden,
    send: forbidden,
    get socket() {
      throw Error("Socket getter must not be invoked");
    },
  });
  const native = Object.freeze({
    host: "https://SECRET-SERVER.example",
    key: "SECRET-KEY",
    vaultName: "SECRET-NOTE",
    server: transport,
    setup: forbidden,
    getHost: forbidden,
    connectToVault: forbidden,
    getServer: forbidden,
    asyncGetServer() {
      return capturedAccount.token;
    },
    _sync() {
      if (!capturedAccount.token) throw Error("Not logged in");
    },
  });
  const plugin = Object.freeze({ instance: native, enabled: true });
  const app = Object.freeze({
    workspace: { onLayoutReady: (callback) => callback() },
    internalPlugins: Object.freeze({
      getPluginById(id) {
        assert.equal(id, "sync");
        return plugin;
      },
    }),
    get account() {
      throw Error("Account getter must not be invoked");
    },
    get vault() {
      throw Error("Vault must not be read");
    },
  });
  return { native, transport, app };
}

test("mobile report is read-only, fingerprinted and excludes account/file/source values", async () => {
  const { app, native, transport } = fixture();
  const before = Object.getOwnPropertyDescriptors(native);
  const transportBefore = Object.getOwnPropertyDescriptors(transport);
  const report = await collectReport({
    app,
    platform: { isIosApp: true },
    appVersion: "1.15.1",
    pluginVersion: "0.1.2",
    runtime: { subtle: webcrypto.subtle, TextEncoder, hasWebSocket: true },
  });
  assert.equal(report.mode, "read-only-diagnostics");
  assert.equal(report.routingActive, false);
  assert.equal(report.native.found, true);
  assert.equal(report.native.engineMethods._sync.mentionsAccountToken, true);
  assert.match(
    report.native.engineMethods._sync.sourceSha256,
    /^[a-f0-9]{64}$/,
  );
  const json = JSON.stringify(report);
  for (const secret of [
    "SECRET-TOKEN",
    "SECRET-SERVER",
    "SECRET-KEY",
    "SECRET-NOTE",
    "capturedAccount",
    "function",
    "Not logged in",
  ])
    assert.equal(json.includes(secret), false, secret);
  assert.deepEqual(Object.getOwnPropertyDescriptors(native), before);
  assert.deepEqual(
    Object.getOwnPropertyDescriptors(transport),
    transportBefore,
  );
});

test("diagnostics do not invoke getters and tolerate absent transports and crypto", async () => {
  const native = {};
  Object.defineProperty(native, "server", {
    get() {
      throw Error("Do not invoke getter");
    },
  });
  Object.defineProperty(native, "getHost", {
    get() {
      throw Error("Do not invoke getter");
    },
  });
  const app = {
    internalPlugins: {
      getPluginById: () => ({ enabled: false, instance: native }),
    },
  };
  const report = await collectReport({
    app,
    platform: { isAndroidApp: true },
    appVersion: "1.15.1",
  });
  assert.equal(report.native.server.hasGetter, true);
  assert.equal(report.native.server.instanceAvailable, false);
  assert.equal(report.native.engineMethods.getHost.callable, false);
  assert.equal(report.native.transportMethods.connect.found, false);
  const absent = await collectReport({
    app: {},
    platform: {},
    appVersion: "unknown",
  });
  assert.equal(absent.native.found, false);
});

test("mobile dependency graph builds for a browser with only the Obsidian SDK external", () => {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, "plugin/src/ios-main.cjs")],
    bundle: true,
    platform: "browser",
    format: "cjs",
    write: false,
    external: ["obsidian"],
    metafile: true,
  });
  const names = Object.keys(result.metafile.inputs);
  assert.equal(
    names.some((name) =>
      /relay|coordinator|account-router|node_modules/.test(name),
    ),
    false,
  );
  assert.ok(result.outputFiles[0].text.length > 0);
});

function element() {
  return {
    children: [],
    style: {},
    empty() {
      this.children = [];
    },
    createEl(tag, attrs = {}) {
      const e = element();
      Object.assign(e, attrs, { tag });
      this.children.push(e);
      return e;
    },
    setAttribute() {},
    focus() {},
    select() {
      this.selected = true;
    },
  };
}

function sdk(platform) {
  const state = {
    tabs: [],
    commands: [],
    modals: [],
    buttons: [],
    notices: [],
    toggles: [],
  };
  class Plugin {
    constructor(app) {
      this.app = app;
      this.manifest = { version: "0.1.2" };
    }
    addSettingTab(tab) {
      state.tabs.push(tab);
    }
    addCommand(command) {
      state.commands.push(command);
    }
    loadData() {
      return Promise.resolve({
        enabled: true,
        server: "https://desktop-only.example",
        accountBinding: "https://desktop-only.example",
      });
    }
    saveData() {
      throw Error("Saved settings must not be written on mobile");
    }
    registerDomEvent() {}
  }
  class PluginSettingTab {
    constructor(app) {
      this.app = app;
      this.containerEl = element();
    }
  }
  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = element();
      state.modals.push(this);
    }
    open() {
      this.onOpen();
    }
  }
  class Setting {
    setName(name) {
      this.name = name;
      return this;
    }
    setDesc() {
      return this;
    }
    addText(callback) {
      const input = {
        inputEl: {},
        setPlaceholder() {
          return this;
        },
        setValue() {
          return this;
        },
        onChange() {
          return this;
        },
      };
      callback(input);
      return this;
    }
    addToggle(callback) {
      const toggle = {
        name: this.name,
        setValue(value) {
          this.value = value;
          return this;
        },
        setDisabled(value) {
          this.disabled = value;
          return this;
        },
        onChange(fn) {
          this.change = fn;
          return this;
        },
      };
      state.toggles.push(toggle);
      callback(toggle);
      return this;
    }
    addDropdown(callback) {
      const input = {
        addOption() {
          return this;
        },
        setValue() {
          return this;
        },
        onChange() {
          return this;
        },
      };
      callback(input);
      return this;
    }
    addButton(callback) {
      const button = {
        setButtonText(text) {
          this.text = text;
          return this;
        },
        onClick(fn) {
          this.click = fn;
          return this;
        },
      };
      state.buttons.push(button);
      callback(button);
      return this;
    }
  }
  class Notice {
    constructor(text) {
      state.notices.push(text);
    }
  }
  return {
    state,
    exports: {
      Plugin,
      PluginSettingTab,
      Setting,
      Modal,
      Notice,
      Platform: platform,
      apiVersion: "1.15.1",
    },
  };
}

const bundled = esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: sdkExternal,
  write: false,
}).outputFiles[0].text;

test("one bundled plugin loads on iOS/Android without process, Buffer, Node, Electron or network access", async () => {
  for (const platform of [{ isIosApp: true }, { isAndroidApp: true }, {}]) {
    const { state, exports: obsidian } = sdk(platform);
    const { app } = fixture();
    let copied;
    const required = [];
    const module = { exports: {} };
    const context = vm.createContext({
      module,
      exports: module.exports,
      require(name) {
        required.push(name);
        assert.equal(name, "obsidian");
        return obsidian;
      },
      crypto: webcrypto,
      TextEncoder,
      WebSocket: function () {
        throw Error("Mobile diagnostics must not open a socket");
      },
      fetch() {
        throw Error("Mobile diagnostics must not fetch");
      },
      navigator: {
        clipboard: {
          async writeText(text) {
            copied = text;
          },
        },
      },
      document: { hidden: false },
      window: { setInterval: () => 1, clearInterval() {} },
    });
    Object.defineProperty(context, "localStorage", {
      get() {
        throw Error("Account storage must not be accessed");
      },
    });
    assert.equal(vm.runInContext("typeof process", context), "undefined");
    assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
    vm.runInContext(bundled, context);
    const plugin = new module.exports(app);
    await plugin.onload();
    assert.equal(
      plugin.state,
      platform.isIosApp
        ? "Experimental iOS adapter inactive"
        : "Mobile diagnostics only — custom Sync is inactive",
    );
    assert.equal(state.tabs.length, 1);
    state.tabs[0].display();
    assert.ok(state.buttons.some((b) => b.text === "Inspect compatibility"));
    const report = await state.commands[0].callback();
    assert.equal(report.routingActive, false);
    assert.equal(state.modals.length, 1);
    const copy = state.buttons.find((b) => b.text === "Copy report");
    await copy.click();
    assert.equal(JSON.parse(copied).routingActive, false);
    assert.equal(copied.includes("SECRET-"), false);
    state.modals[0].onClose();
    assert.equal(state.modals[0].report, null);
    assert.deepEqual([...new Set(required)], ["obsidian"]);
    await plugin.onunload?.();
  }
});

test("iOS bridge exposes native attachment categories without official settings or account calls", async () => {
  const { state, exports: obsidian } = sdk({ isIosApp: true }),
    module = { exports: {} };
  const context = vm.createContext({
    module,
    require(name) {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    document: { hidden: false },
    window: { setInterval: () => 1, clearInterval() {} },
  });
  vm.runInContext(bundled, context);
  const plugin = new module.exports({ workspace: { onLayoutReady: () => {} } });
  await plugin.onload();
  plugin.controller.session = { authenticated: true };
  plugin.controller.native = {
    vaultId: "owned",
    filter: { allowTypes: new Set(["image", "pdf"]), ignoreFolders: [] },
  };
  const changed = [];
  plugin.controller.setFileType = async (type, value) =>
    changed.push([type, value]);
  state.tabs[0].display();
  assert.equal(state.toggles.length, 5);
  const other = state.toggles.find((t) => t.name === "Sync all other types");
  assert.equal(other.value, false);
  await other.change(true);
  assert.deepEqual(changed, [["unsupported", true]]);
  assert.equal(state.toggles.find((t) => t.name === "Sync images").value, true);
  plugin.controller.native = null;
  plugin.controller.session = null;
  await plugin.onunload();
});

test("mobile clipboard failure keeps the local report selectable without logging an error body", async () => {
  const { state, exports: obsidian } = sdk({ isIosApp: true });
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    navigator: {
      clipboard: {
        async writeText() {
          throw Error("SECRET-ERROR");
        },
      },
    },
    document: { hidden: false },
    window: { setInterval: () => 1, clearInterval() {} },
  });
  vm.runInContext(bundled, context);
  const plugin = new module.exports({
    workspace: { onLayoutReady: (callback) => callback() },
  });
  await plugin.onload();
  await plugin.inspect();
  await state.buttons.find((b) => b.text === "Copy report").click();
  const field = state.modals[0].contentEl.children.find(
    (e) => e.tag === "textarea",
  );
  assert.equal(field.selected, true);
  assert.equal(state.notices.join("").includes("SECRET-ERROR"), false);
  await plugin.onunload?.();
});

test("desktop renderer and main-process entry points retain their original branches", () => {
  const source = fs.readFileSync(entry, "utf8");
  for (const platform of [
    { isDesktopApp: true, isMacOS: true },
    { isDesktopApp: true, isWin: true },
  ]) {
    const module = { exports: {} },
      marker = {};
    const context = vm.createContext({
      module,
      require(name) {
        if (name === "obsidian") return { Platform: platform };
        if (name === "./compatibility.cjs") return { compatibility };
        assert.equal(name, "./main.cjs");
        return marker;
      },
    });
    vm.runInContext(source, context);
    assert.equal(module.exports, marker);
  }
  const module = { exports: {} },
    marker = {};
  vm.runInNewContext(source, {
    module,
    process: { type: "browser" },
    require(name) {
      assert.equal(name, "./main-coordinator.cjs");
      return marker;
    },
  });
  assert.equal(module.exports, marker);
});
