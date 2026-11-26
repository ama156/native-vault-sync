"use strict";

const { Platform, Plugin, Notice, apiVersion } = require("obsidian");
const DirectSyncBridge = require("./ios-main.cjs");
const { MAC_1151, macDirectRequest } = require("./mac-direct.cjs");

module.exports = Platform.isMacOS && apiVersion === "1.15.1"
  ? class MacDirectPrerelease extends DirectSyncBridge {
      async onload() {
        const settings = await this.loadData();
        if (settings?.enabled || settings?.accountBinding) {
          new Notice("This profile uses desktop routing. Keep Vault Sync Bridge 0.2.0 for that connection.");
          return;
        }
        await this.loadDirect("macDirect", MAC_1151, macDirectRequest);
      }
    }
  : class UnsupportedMacPrerelease extends Plugin {
      onload() {
        new Notice("Vault Sync Bridge 0.2.1 requires Obsidian 1.15.1 on macOS.");
      }
    };
