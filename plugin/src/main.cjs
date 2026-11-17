"use strict";
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  apiVersion,
} = require("obsidian");
const { Relay, validateServer } = require("./relay.cjs");
const path = require("node:path");
const { installBootstrap } = require("./connection-bootstrap.cjs");
const SUPPORTED = new Set(["1.8.7", "1.15.1"]);

module.exports = class VaultSyncBridge extends Plugin {
  async onload() {
    this.settings = Object.assign(
      { server: "", enabled: false, accountBinding: "" },
      await this.loadData(),
    );
    this.events = [];
    this.state = "Inactive";
    this.addSettingTab(new BridgeSettings(this.app, this));
    this.addCommand({
      id: "open-bridge-settings",
      name: "Open connection settings",
      callback: () => {
        this.app.setting.open();
        this.app.setting.openTabById(this.manifest.id);
      },
    });
    if (this.settings.enabled) {
      try {
        await this.activate();
      } catch (error) {
        this.state = error.message;
        this.record("activation-failed");
        new Notice("Vault Sync Bridge: " + error.message);
      }
    }
  }
  record(event) {
    this.events.push({ at: new Date().toISOString(), event });
    this.events = this.events.slice(-30);
  }
  getNative() {
    if (!SUPPORTED.has(apiVersion))
      throw new Error(
        "Desktop " +
          apiVersion +
          " is not qualified. Available adapters: 1.8.7 and 1.15.1.",
      );
    const sync = this.app.internalPlugins?.getPluginById("sync")?.instance;
    if (
      !sync ||
      typeof sync.getHost !== "function" ||
      typeof sync.setPause !== "function"
    )
      throw new Error("Enable the native Sync core plugin first.");
    return sync;
  }
  async testConnection() {
    const origin = validateServer(this.settings.server);
    const response = await fetch(origin + "/healthz", {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const health = await response.json();
    if (
      !response.ok ||
      health.service !== "vault-sync-server" ||
      health.bridge_protocol !== 1 ||
      health.ready !== true
    )
      throw new Error("This address is not a ready compatible server.");
    return origin;
  }
  async activate() {
    if (this.relay && this.routingActive) return;
    if (this.relay) await this.deactivate(false);
    const origin = validateServer(this.settings.server);
    const native = this.getNative();
    let account = {};
    try {
      account = JSON.parse(localStorage.getItem("obsidian-account") || "{}");
    } catch {}
    if (
      account.token &&
      (this.settings.accountBinding !== origin ||
        !String(account.token).startsWith("vs1_"))
    ) {
      throw new Error(
        "Sign out of the existing account in native account settings before enabling custom routing.",
      );
    }
    if (native.vaultId && this.settings.accountBinding !== origin)
      throw new Error(
        "Disconnect the existing native remote vault before selecting a different server. Local notes will remain.",
      );
    const contents = window.electronWindow?.webContents;
    if (!contents?.debugger)
      throw new Error("Electron account-routing adapter is unavailable.");
    const remote = window.electron?.remote;
    if (!remote?.require)
      throw new Error("The desktop main-process adapter is unavailable.");
    const ownFile = path.resolve(
      this.app.vault.adapter.getBasePath(),
      this.manifest.dir,
      "main.js",
    );
    this.coordinator = remote.require(ownFile);
    if (this.coordinator.protocol !== 1)
      throw new Error("Incompatible routing coordinator. Restart the app.");
    this.lease = await this.coordinator.acquire(
      contents.id,
      origin,
      (event) => {
        this.record(event);
        if (event === "account-routing-detached") {
          this.native?.server?.disconnect();
          this.routingActive = false;
          this.state =
            "Account routing detached. Close Developer Tools and re-enable routing.";
          new Notice(this.state);
        }
      },
    );
    this.routingActive = true;
    this.native = native;
    this.originalGetHost = native.getHost;
    native.server?.disconnect();
    native.server = null;
    try {
      this.relay = new Relay(origin, (event) => {
        this.record(event);
        this.state =
          event === "upstream-error"
            ? "Server unavailable; native Sync will retry"
            : "Routing active";
      });
      const local = await this.relay.start();
      this.overrideGetHost = () => local;
      native.getHost = this.overrideGetHost;
      if (apiVersion === "1.15.1")
        this.restoreBootstrap = installBootstrap(native, local);
      this.settings.accountBinding = origin;
      this.settings.enabled = true;
      await this.saveData(this.settings);
      this.state = "Routing active";
      this.record("routing-enabled");
      native.requestSync?.();
    } catch (error) {
      await this.deactivate(false);
      throw error;
    }
  }
  async deactivate(persist = true) {
    this.native?.server?.disconnect();
    if (this.native) this.native.server = null;
    this.restoreBootstrap?.();
    this.restoreBootstrap = null;
    if (this.native?.getHost === this.overrideGetHost)
      this.native.getHost = this.originalGetHost;
    if (this.coordinator && this.lease)
      await this.coordinator.release(this.lease);
    this.lease = null;
    this.routingActive = false;
    await this.relay?.stop();
    this.relay = null;
    this.state = "Inactive";
    this.record("routing-disabled");
    if (persist) {
      this.settings.enabled = false;
      await this.saveData(this.settings);
    }
  }
  async onunload() {
    await this.deactivate(false);
  }
};

class BridgeSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const plugin = this.plugin;
    this.containerEl.empty();
    this.containerEl.createEl("p", {
      text: "Native Sync handles your files and encryption. This desktop adapter connects it to your personal server. Use a custom-server account only in this profile.",
    });
    new Setting(this.containerEl)
      .setName("Server address")
      .setDesc("HTTPS origin, for example https://obsidianvault.example.com.")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidianvault.example.com")
          .setValue(plugin.settings.server)
          .onChange(async (value) => {
            let account = {};
            try {
              account = JSON.parse(
                localStorage.getItem("obsidian-account") || "{}",
              );
            } catch {}
            if (account.token && value.trim() !== plugin.settings.server) {
              text.setValue(plugin.settings.server);
              new Notice(
                "Sign out of the custom account before changing the server address.",
              );
              return;
            }
            if (plugin.relay) await plugin.deactivate();
            plugin.settings.server = value.trim();
            await plugin.saveData(plugin.settings);
          }),
      );
    new Setting(this.containerEl)
      .setName("Connection")
      .setDesc(plugin.state)
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          try {
            await plugin.testConnection();
            new Notice("Compatible server is ready.");
          } catch (error) {
            new Notice(error.message);
          }
        }),
      );
    new Setting(this.containerEl)
      .setName("Custom server routing")
      .setDesc(
        "Sign out of any official account first. Then sign in and connect your vault through native settings.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(!!plugin.relay && plugin.routingActive)
          .onChange(async (enabled) => {
            try {
              if (enabled) {
                await plugin.testConnection();
                await plugin.activate();
              } else await plugin.deactivate();
            } catch (error) {
              plugin.state = error.message;
              new Notice(error.message);
            }
            this.display();
          }),
      );
    this.containerEl.createEl("p", {
      text:
        "Compatibility: " +
        apiVersion +
        (SUPPORTED.has(apiVersion)
          ? " — sandbox-tested experimental adapter."
          : " — unsupported; routing will remain inactive."),
    });
    new Setting(this.containerEl)
      .setName("Diagnostics")
      .setDesc("Contains event names and timestamps only.")
      .addButton((button) =>
        button.setButtonText("Copy diagnostics").onClick(async () => {
          await navigator.clipboard.writeText(
            JSON.stringify(
              {
                version: apiVersion,
                state: plugin.state,
                events: plugin.events,
              },
              null,
              2,
            ),
          );
          new Notice("Redacted diagnostics copied.");
        }),
      );
  }
}
