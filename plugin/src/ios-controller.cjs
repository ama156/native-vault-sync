"use strict";
const { validateServer } = require("./server-address.cjs");
const {
  IOS_1151,
  fingerprint,
  captureFreshAccount,
  bindAccount,
} = require("./ios-account.cjs");
const { MobileSession } = require("./mobile-session.cjs");
const { installDirectConnection } = require("./ios-connection.cjs");

class IOSController {
  constructor(app, settings, request, save, changed = () => {}) {
    this.app = app;
    this.settings = settings;
    this.request = request;
    this.save = save;
    this.changed = changed;
    this.session = null;
    this.native = null;
    this.restoreAccount = null;
    this.restoreConnection = null;
    this.state = "Experimental iOS adapter inactive";
    this.generation = 0;
  }
  status(text) {
    this.state = text;
    this.changed();
  }
  async testServer() {
    const origin = validateServer(this.settings.server);
    let response;
    try {
      response = await this.request({
        url: origin + "/healthz",
        method: "GET",
        throw: false,
      });
    } catch {
      throw Error("Custom server unavailable. Check HTTPS and the address.");
    }
    const data = response.json;
    if (
      response.status !== 200 ||
      data?.service !== "vault-sync-server" ||
      data.bridge_protocol !== 1 ||
      data.ready !== true
    )
      throw Error("The address is not a ready compatible server.");
    const parts = String(data.version).split(".").map(Number);
    if (!(parts[0] > 0 || parts[1] > 1 || (parts[1] === 1 && parts[2] >= 2)))
      throw Error(
        "Install server 0.1.2 or newer for the exact iOS Origin support.",
      );
    return origin;
  }
  async getNative() {
    const record = this.app.internalPlugins?.getPluginById("sync");
    const native = record?.instance;
    if (record?.enabled && native)
      for (
        let i = 0;
        i < 200 && (!native.initialized || !native.dataLoaded);
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
    if (!record?.enabled || !native?.initialized || !native.dataLoaded)
      throw Error(
        "Enable the native Sync core plugin and wait for vault startup.",
      );
    const host = new URL(validateServer(this.settings.server)).host + "/sync";
    if (
      native.vaultId &&
      (native.vaultId !== this.settings.vaultId || native.host !== host)
    )
      throw Error(
        "This vault already has another native Sync connection. Use an unconnected disposable vault; it was not changed.",
      );
    if ((await fingerprint(native.setup)) !== IOS_1151.setup)
      throw Error("Unqualified iOS vault setup implementation.");
    return native;
  }
  async establish(email, password, resume = false) {
    if (this.session)
      throw Error(
        "Sign out in bridge settings before changing the account/server.",
      );
    const generation = ++this.generation;
    const current = () => {
      if (generation !== this.generation)
        throw Error("Bridge operation cancelled.");
    };
    const origin = await this.testServer();
    current();
    const native = await this.getNative();
    current();
    // Probe before sending credentials: existing native accounts are refused.
    const account = await captureFreshAccount(native);
    current();
    const secrets = this.app.secretStorage;
    if (
      !secrets?.getSecret ||
      !secrets?.setSecret ||
      !secrets?.deleteSecret ||
      secrets.isEncryptionAvailable?.() !== true
    )
      throw Error("Device-local encrypted secret storage is required.");
    const identity = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(origin + "|" + this.app.appId),
    );
    current();
    const secretId =
      "vault-sync-bridge-" +
      Array.from(new Uint8Array(identity))
        .slice(0, 12)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const session = new MobileSession(
      origin,
      this.request,
      secrets,
      secretId,
      () => this.expired(),
    );
    try {
      if (resume) {
        if (!(await session.restore())) {
          this.status("Sign in to the custom server to resume");
          return false;
        }
      } else await session.login(email, password);
      current();
      this.native = native;
      this.session = session;
      this.restoreAccount = bindAccount(account, session);
      this.restoreConnection = installDirectConnection(native, session);
      this.settings.enabled = true;
      await this.save();
      current();
      if (native.vaultId) {
        native.setPause(false);
        native.requestSync();
        this.status(
          "Custom Sync enabled — use native Sync status to check convergence",
        );
      } else this.status("Signed in to custom server — select a remote vault");
      return true;
    } catch (error) {
      if (generation !== this.generation && session.authenticated) {
        try {
          await session.signOut();
        } catch {
          session.clearMemory();
        }
      } else {
        session.clearMemory();
        await this.stop(false);
      }
      throw error;
    }
  }
  async vaults() {
    if (!this.session) throw Error("Sign in first.");
    const result = await this.session.call("/vault/list", {
      supported_encryption_version: 3,
    });
    if (!Array.isArray(result.vaults))
      throw Error("Invalid remote vault list.");
    return result.vaults.filter((v) =>
      [0, 2, 3].includes(v.encryption_version),
    );
  }
  async connect(vault, password) {
    if (!this.session?.authenticated || !this.native)
      throw Error("Sign in first.");
    if (this.native.vaultId)
      throw Error(
        "This test vault is already configured. Create another disposable local vault to select a different remote vault.",
      );
    const expectedHost = new URL(this.session.server).host + "/sync";
    if (
      !vault ||
      vault.host !== expectedHost ||
      ![0, 2, 3].includes(vault.encryption_version) ||
      !vault.id ||
      !vault.salt
    )
      throw Error("Remote vault metadata does not match this server.");
    const native = this.native,
      generation = this.generation;
    const current = () => {
      if (generation !== this.generation)
        throw Error("Bridge operation cancelled.");
    };
    native.setPause(true);
    try {
      await native.setup(
        vault.id,
        vault.name,
        password,
        vault.salt,
        vault.host,
        vault.encryption_version,
      );
      current();
      // Encryption is native. This creates the provider and performs our access
      // preflight/login while still paused, so a wrong password cannot upload.
      const transport = await native.getServer();
      current();
      if (!transport)
        throw Error(
          "Vault unlock/login failed. Recheck the vault password and native Sync log.",
        );
      this.settings.vaultId = vault.id;
      await this.save();
      current();
      native.setPause(false);
      native.requestSync();
      this.status(
        "Custom Sync enabled — use native Sync status to check convergence",
      );
    } catch (error) {
      native.setPause(true);
      // This flow only permits an originally unconfigured local test vault.
      // Remove unsuccessful remote setup; local files are never deleted.
      await native.unsetup();
      throw error;
    }
  }
  expired() {
    this.native?.setPause(true);
    this.native?.server?.disconnect();
    this.status(
      "Custom session expired/revoked — sign out here, then sign in again",
    );
  }
  async foreground() {
    if (!this.session?.authenticated) return;
    try {
      await this.session.refresh();
      this.native?.requestSync();
    } catch {
      if (this.session?.authenticated)
        this.status("Custom server unavailable; native changes remain queued");
    }
  }
  async signOut() {
    try {
      await this.session?.signOut();
    } finally {
      await this.stop(true);
    }
  }
  async stop(persist = false) {
    this.generation++;
    if (this.native) {
      if (this.native.vaultId) this.native.setPause(true);
      this.native.server?.disconnect();
      this.native.server = null;
    }
    this.restoreConnection?.();
    this.restoreConnection = null;
    this.restoreAccount?.();
    this.restoreAccount = null;
    this.session?.clearMemory();
    this.session = null;
    this.native = null;
    if (persist) {
      this.settings.enabled = false;
      await this.save();
    }
    this.status("Experimental iOS adapter inactive");
  }
}

function prepareEmptyNativeAccount(app, storage) {
  const native = app.internalPlugins?.getPluginById("sync")?.instance;
  if (native?.vaultId || native?.server)
    throw Error(
      "Existing native Sync state must remain unchanged. Use an unconnected disposable test vault.",
    );
  const raw = storage.getItem("obsidian-account");
  if (raw === null) return false;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error("Native account state cannot be verified; it was not changed.");
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some(
      (k) => !["token", "email", "name", "license", "key"].includes(k),
    ) ||
    Object.values(data).some((v) => v !== "" && v !== null && v !== undefined)
  )
    throw Error(
      "An existing native account/license was found. Nothing was changed. Use a clean test environment.",
    );
  storage.removeItem("obsidian-account");
  return true;
}
module.exports = { IOSController, prepareEmptyNativeAccount };
