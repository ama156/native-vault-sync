"use strict";
const ROUTES = new Set([
  "/user/signin",
  "/user/info",
  "/user/signout",
  "/subscription/list",
  "/vault/list",
  "/vault/regions",
  "/vault/create",
  "/vault/access",
  "/vault/rename",
  "/vault/delete",
]);
// The app disables webRequest registration. Fetch interception leaves its existing
// app:// origin and response protections installed and does not replace fetch.
class AccountRouter {
  constructor(contents, origin, event = () => {}, detached = () => {}) {
    this.debugger = contents.debugger;
    this.origin = origin;
    this.event = event;
    this.detached = detached;
    this.owned = false;
    this.message = (_event, method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const { requestId, request } = params;
      let next;
      try {
        const url = new URL(request.url);
        if (
          url.origin !== "https://api.obsidian.md" ||
          !ROUTES.has(url.pathname) ||
          !["POST", "OPTIONS"].includes(request.method)
        ) {
          next = this.debugger.sendCommand("Fetch.failRequest", {
            requestId,
            errorReason: "BlockedByClient",
          });
          this.event("account-operation-blocked");
        } else {
          next = this.debugger.sendCommand("Fetch.continueRequest", {
            requestId,
            url: this.origin + url.pathname,
          });
          this.event("account-request-routed");
        }
        next.catch(() => this.event("account-routing-error"));
      } catch {
        this.debugger
          .sendCommand("Fetch.failRequest", {
            requestId,
            errorReason: "BlockedByClient",
          })
          .catch(() => {});
      }
    };
    this.detach = (_event, reason) => {
      const unexpected = this.owned;
      this.owned = false;
      if (unexpected && reason !== "target_closed" && !contents.isDestroyed())
        this.detached();
    };
  }
  async start() {
    if (this.debugger.isAttached())
      throw new Error(
        "Close Developer Tools or the existing debugger before enabling routing.",
      );
    this.debugger.attach("1.3");
    this.owned = true;
    this.debugger.on("message", this.message);
    this.debugger.on("detach", this.detach);
    try {
      await this.debugger.sendCommand("Fetch.enable", {
        patterns: [
          { urlPattern: "https://api.obsidian.md/*", requestStage: "Request" },
        ],
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop() {
    this.debugger.removeListener("message", this.message);
    this.debugger.removeListener("detach", this.detach);
    if (this.owned) {
      this.owned = false;
      await this.debugger.sendCommand("Fetch.disable").catch(() => {});
      this.debugger.detach();
    }
  }
}
module.exports = { AccountRouter, ROUTES };
