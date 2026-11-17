"use strict";
const { PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");
const Diagnostics = require("./mobile-diagnostics.cjs");
const { FILE_TYPES } = require("./native-file-types.cjs");
const {
  IOSController,
  prepareEmptyNativeAccount,
} = require("./ios-controller.cjs");

module.exports = class VaultSyncBridgeIOS extends Diagnostics {
  async onload() {
    this.loaded = true;
    this.busy = false;
    this.vaults = [];
    this.persisted = (await this.loadData().catch(() => ({}))) || {};
    // Never inherit the desktop's enabled/server flags from a synced data.json.
    this.ios = Object.assign(
      { server: "", enabled: false, vaultId: "" },
      this.persisted.iosTest,
    );
    this.controller = new IOSController(
      this.app,
      this.ios,
      requestUrl,
      () => this.saveData({ ...this.persisted, iosTest: this.ios }),
      () => {
        this.state = this.controller.state;
      },
    );
    await super.onload();
    this.state = this.controller.state;
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) this.controller.foreground();
    });
    this.registerDomEvent(window, "focus", () => this.controller.foreground());
    this.poll = window.setInterval(() => {
      if (!document.hidden) this.controller.foreground();
    }, 60000);
    this.app.workspace.onLayoutReady(() => {
      if (this.loaded && this.ios.enabled)
        this.run(() => this.controller.establish("", "", true));
    });
  }
  createSettingsTab() {
    this.iosTab = new IOSSettings(this.app, this);
    return this.iosTab;
  }
  async run(action) {
    if (this.busy || !this.loaded) return;
    this.busy = true;
    try {
      return await action();
    } catch (error) {
      if (this.loaded) new Notice(error.message || "Bridge operation failed.");
    } finally {
      this.busy = false;
      if (this.loaded && this.iosTab?.containerEl?.isShown?.())
        this.iosTab.display();
    }
  }
  async onunload() {
    this.loaded = false;
    window.clearInterval(this.poll);
    await this.controller?.stop(false);
  }
};

class IOSSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const p = this.plugin,
      c = p.controller;
    this.containerEl.empty();
    this.containerEl.createEl("p", {
      text: "Experimental iOS 1.15.1 native Sync adapter. Note sync/restart is user-confirmed; attachment behavior remains under device qualification. Use a clean account environment and an unconnected disposable local vault. Existing accounts and connections are refused.",
    });
    this.containerEl.createEl("p", { text: c.state });
    new Setting(this.containerEl)
      .setName("Custom server")
      .setDesc("HTTPS origin; server 0.1.2 or newer is required.")
      .addText((input) =>
        input
          .setPlaceholder("https://sync.example.com")
          .setValue(p.ios.server)
          .onChange((value) => {
            if (c.session || p.busy) {
              input.setValue(p.ios.server);
              return;
            }
            p.ios.server = value.trim();
          }),
      );
    new Setting(this.containerEl)
      .setName("Server connection")
      .addButton((button) =>
        button.setButtonText("Test server").onClick(() =>
          p.run(async () => {
            await c.testServer();
            new Notice("Custom server is ready for the iOS test.");
          }),
        ),
      );
    if (!c.session?.authenticated) {
      let email = "",
        password = "",
        passwordInput;
      new Setting(this.containerEl)
        .setName("Custom account email")
        .addText((input) =>
          input.onChange((value) => {
            email = value;
          }),
        );
      new Setting(this.containerEl)
        .setName("Custom account password")
        .addText((input) => {
          passwordInput = input;
          input.inputEl.type = "password";
          input.onChange((value) => {
            password = value;
          });
        });
      new Setting(this.containerEl)
        .setName("Custom account")
        .setDesc(
          "This does not use an official Obsidian login. Passwords are not saved.",
        )
        .addButton((button) =>
          button.setButtonText("Sign in to custom server").onClick(() =>
            p.run(async () => {
              const value = password;
              password = "";
              passwordInput?.setValue("");
              await c.establish(email, value);
              p.vaults = await c.vaults();
            }),
          ),
        );
    }
    if (c.session) {
      new Setting(this.containerEl)
        .setName("Custom session")
        .addButton((button) =>
          button.setButtonText("Sign out / disable").onClick(() =>
            p.run(async () => {
              await c.signOut();
              p.vaults = [];
            }),
          ),
        );
    }
    if (c.session?.authenticated && !c.native?.vaultId) {
      new Setting(this.containerEl)
        .setName("Remote vaults")
        .setDesc(
          "Create the remote vault on desktop first. The iOS test connects to an existing end-to-end encrypted vault.",
        )
        .addButton((button) =>
          button.setButtonText("Refresh vault list").onClick(() =>
            p.run(async () => {
              p.vaults = await c.vaults();
            }),
          ),
        );
      let selected = p.vaults[0]?.id || "",
        password = "",
        passwordInput;
      new Setting(this.containerEl)
        .setName("Remote vault")
        .addDropdown((input) => {
          for (const v of p.vaults) input.addOption(v.id, v.name);
          input.setValue(selected).onChange((value) => {
            selected = value;
          });
        });
      new Setting(this.containerEl)
        .setName("Vault encryption password")
        .addText((input) => {
          passwordInput = input;
          input.inputEl.type = "password";
          input.onChange((value) => {
            password = value;
          });
        });
      new Setting(this.containerEl)
        .setName("Connect disposable local vault")
        .setDesc(
          "Native Sync encrypts/decrypts and reconciles files. Test data only.",
        )
        .addButton((button) =>
          button.setButtonText("Unlock and connect").onClick(() =>
            p.run(async () => {
              const value = password;
              password = "";
              passwordInput?.setValue("");
              await c.connect(
                p.vaults.find((v) => v.id === selected),
                value,
              );
            }),
          ),
        );
    }
    if (c.session?.authenticated && c.native?.vaultId) {
      const preferences = c.fileTypes();
      this.containerEl.createEl("h3", { text: "Attachments / selective sync" });
      this.containerEl.createEl("p", {
        text: "These native file-type settings apply to this device only. Enable the matching types on every device. ZIP/EPUB require all other types. No official account login is needed here.",
      });
      if (preferences.available) {
        for (const type of FILE_TYPES) {
          new Setting(this.containerEl)
            .setName(type.name)
            .setDesc(type.description)
            .addToggle((toggle) =>
              toggle
                .setValue(preferences.types[type.id])
                .setDisabled(p.busy)
                .onChange((value) =>
                  p.run(() => c.setFileType(type.id, value)),
                ),
            );
        }
        this.containerEl.createEl("p", {
          text: `Excluded folders: ${preferences.excludedFolderCount ?? "unknown"}. File-type toggles preserve existing folder exclusions.`,
        });
        if (typeof c.native.showSyncLog === "function") {
          new Setting(this.containerEl)
            .setName("Sync activity log")
            .setDesc(
              "View native upload/download errors without opening account settings.",
            )
            .addButton((button) =>
              button.setButtonText("View sync log").onClick(() =>
                p.run(async () => {
                  c.native?.showSyncLog();
                }),
              ),
            );
        }
        new Setting(this.containerEl)
          .setName("Refresh attachment settings")
          .setDesc(
            "Reload these values after changing native settings elsewhere.",
          )
          .addButton((button) =>
            button.setButtonText("Refresh").onClick(() => this.display()),
          );
      } else {
        this.containerEl.createEl("p", {
          text: "Native file-type settings are unavailable. Collect the read-only compatibility report.",
        });
      }
    }
    new Setting(this.containerEl)
      .setName("Saved signed-out test profile")
      .setDesc(
        "Optional: remove only a verified empty native account record, then fully quit/reopen Obsidian. Refuses any account, license or remote-vault connection. Does not sign out an existing account.",
      )
      .addButton((button) =>
        button.setButtonText("Prepare empty account record").onClick(() =>
          p.run(async () => {
            if (c.session) throw Error("Disable the bridge session first.");
            const changed = prepareEmptyNativeAccount(this.app, localStorage);
            new Notice(
              changed
                ? "Empty account record removed. Fully quit and reopen this test app before signing in."
                : "No saved native account record exists; try custom sign-in.",
            );
          }),
        ),
      );
    new Setting(this.containerEl)
      .setName("Read-only compatibility report")
      .addButton((button) =>
        button
          .setButtonText("Inspect compatibility")
          .onClick(() => p.inspect()),
      );
    this.containerEl.createEl("p", {
      text: "Use bridge settings for account/vault setup. Native account operations that try to serialize the local session handle are blocked before network transmission. Disabling the bridge pauses this custom connection and keeps local notes and native history/index state. No background-sync guarantee or Android qualification.",
    });
  }
}
