"use strict";
const { validateServer } = require("./server-address.cjs");
const ROUTES = new Set([
  "/user/signin",
  "/user/info",
  "/user/signout",
  "/vault/list",
  "/vault/access",
]);
class SessionExpired extends Error {}

class MobileSession {
  #token = "";
  constructor(server, request, secrets, secretId, expired = () => {}) {
    this.server = validateServer(server);
    this.request = request;
    this.secrets = secrets;
    this.secretId = secretId;
    this.expired = expired;
    this.info = null;
  }
  get authenticated() {
    return !!this.#token;
  }
  token() {
    if (!this.#token)
      throw new SessionExpired("Sign in to the custom server again.");
    return this.#token;
  }
  async call(route, payload = {}, token = this.#token) {
    if (!ROUTES.has(route))
      throw Error("Unsupported bridge account operation.");
    const body = { ...payload };
    if (route !== "/user/signin") body.token = token;
    let response;
    try {
      response = await this.request({
        url: this.server + route,
        method: "POST",
        contentType: "application/json",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        throw: false,
      });
    } catch {
      throw Error("Custom server unavailable. Native changes remain queued.");
    }
    if (response.status !== 200)
      throw Error("Custom server returned HTTP " + response.status + ".");
    const result = response.json;
    if (!result || typeof result !== "object")
      throw Error("Invalid custom server response.");
    if (Object.hasOwn(result, "error")) {
      if (result.error === "Not logged in") {
        this.invalidate();
        throw new SessionExpired(
          "Custom session expired or was revoked. Sign in again.",
        );
      }
      // Don't repeat a server-controlled message that could echo credentials.
      throw Error("Custom server rejected this account operation.");
    }
    return result;
  }
  async login(email, password) {
    const result = await this.call("/user/signin", {
      email,
      password,
      mfa: "",
    });
    if (
      typeof result.token !== "string" ||
      !/^vs1_[a-f0-9]{64}$/.test(result.token)
    )
      throw Error("Invalid custom session token.");
    this.#token = result.token;
    this.info = {
      email: result.email || "",
      name: result.name || "",
      license: "",
    };
    try {
      await this.refresh();
    } catch (error) {
      this.clearMemory();
      throw error;
    }
    // Use the app's device-local secret store, never vault plugin data.json.
    try {
      this.secrets.setSecret(
        this.secretId,
        JSON.stringify({ server: this.server, token: this.#token }),
      );
    } catch {
      try {
        await this.call("/user/signout");
      } catch {}
      this.clearMemory();
      throw Error("The device secret store could not save the custom session.");
    }
    return this.info;
  }
  async restore() {
    const text = this.secrets.getSecret(this.secretId);
    if (!text) return false;
    let saved;
    try {
      saved = JSON.parse(text);
    } catch {
      return false;
    }
    if (
      saved.server !== this.server ||
      !/^vs1_[a-f0-9]{64}$/.test(saved.token || "")
    )
      return false;
    this.#token = saved.token;
    try {
      await this.refresh();
      return true;
    } catch (error) {
      this.clearMemory();
      throw error;
    }
  }
  async refresh() {
    const result = await this.call("/user/info");
    this.info = {
      email: result.email || "",
      name: result.name || "",
      license: "",
    };
    return this.info;
  }
  invalidate() {
    this.clearMemory();
    this.secrets.deleteSecret(this.secretId);
    this.expired();
  }
  clearMemory() {
    this.#token = "";
    this.info = null;
  }
  async signOut() {
    try {
      if (this.authenticated) await this.call("/user/signout");
    } finally {
      this.invalidate();
    }
  }
}
module.exports = { MobileSession, SessionExpired };
