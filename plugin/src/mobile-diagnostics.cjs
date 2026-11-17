"use strict";
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  Platform,
  apiVersion,
} = require("obsidian");
const { collectReport } = require("./mobile-report.cjs");

module.exports = class VaultSyncBridgeMobileDiagnostics extends Plugin {
  async onload() {
    this.state = "Mobile diagnostics only — custom Sync is inactive";
    this.addSettingTab(this.createSettingsTab());
    this.addCommand({
      id: "inspect-mobile-compatibility",
      name: "Inspect mobile compatibility (read-only)",
      callback: () => this.inspect(),
    });
    // Deliberately do not load saved enabled settings, read account storage,
    // patch methods, open sockets, or invoke setup/disconnect/requestSync.
  }

  createSettingsTab() {
    return new MobileSettings(this.app, this);
  }

  async inspect() {
    try {
      const report = await collectReport({
        app: this.app,
        platform: Platform,
        appVersion: apiVersion,
        pluginVersion: this.manifest.version,
        runtime: {
          hasWebSocket: typeof globalThis.WebSocket === "function",
          subtle: globalThis.crypto?.subtle,
          TextEncoder: globalThis.TextEncoder,
        },
      });
      if (this.controller) {
        report.routingActive = !!this.controller.session?.authenticated;
        report.mode = report.routingActive
          ? "experimental-ios-adapter-diagnostics"
          : "read-only-diagnostics";
      }
      new ReportModal(this.app, report).open();
      return report;
    } catch {
      new Notice(
        "Compatibility inspection unavailable. No Sync settings were changed.",
      );
      return null;
    }
  }
};

class MobileSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    this.containerEl.empty();
    this.containerEl.createEl("p", { text: this.plugin.state });
    this.containerEl.createEl("p", {
      text: "The native Sync engine requires an internal account session. A safe custom-session integration has not been established on mobile. This build does not log in, route requests, change your account, connect to a server, or alter notes.",
    });
    new Setting(this.containerEl)
      .setName("Compatibility report")
      .setDesc(
        "Inspect method shapes and hashes locally. Account tokens, server addresses, vault paths, note content and function source are excluded. Nothing is uploaded or saved.",
      )
      .addButton((button) =>
        button
          .setButtonText("Inspect compatibility")
          .onClick(() => this.plugin.inspect()),
      );
    this.containerEl.createEl("p", {
      text: "iPhone testing comes first. Android is unqualified. A successful report only verifies diagnostic loading; it does not establish synchronization support. Keep existing accounts and connected vaults unchanged.",
    });
  }
}

class ReportModal extends Modal {
  constructor(app, report) {
    super(app);
    this.report = report;
  }
  onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Mobile compatibility report" });
    this.contentEl.createEl("p", {
      text: "Read-only observations; collecting this report does not change Sync state. Share only this redacted report; do not export account storage or raw network captures.",
    });
    const text = JSON.stringify(this.report, null, 2);
    const field = this.contentEl.createEl("textarea");
    field.value = text;
    field.readOnly = true;
    field.rows = 18;
    field.style.width = "100%";
    field.setAttribute("aria-label", "Redacted compatibility report");
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText("Copy report").onClick(async () => {
        try {
          await globalThis.navigator.clipboard.writeText(text);
          new Notice("Redacted compatibility report copied.");
        } catch {
          field.focus();
          field.select();
          new Notice("Use the system Copy action on the selected report.");
        }
      }),
    );
  }
  onClose() {
    this.contentEl.empty();
    this.report = null;
  }
}
