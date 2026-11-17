"use strict";
// Loaded from the plugin's own bundled asset in Electron's main process. This
// keeps Settings and popout windows covered without changing native protections.
const { app, webContents } = require("electron");
const { AccountRouter } = require("./account-router.cjs");
const { randomBytes } = require("node:crypto");
const KEY = Symbol.for("vault-sync-bridge.main-coordinator.v1");
function makeCoordinator() {
  const leases = new Map(),
    routers = new Map();
  let operations = Promise.resolve(),
    watching = false;
  const serial = (fn) => {
    const next = operations.then(fn);
    operations = next.catch(() => {});
    return next;
  };
  const report = (session, event) => {
    for (const lease of leases.values())
      if (lease.session === session) {
        if (event === "account-routing-detached") lease.active = false;
        try {
          lease.event(event);
        } catch {}
      }
  };
  async function attach(contents, session, origin) {
    if (
      contents.isDestroyed() ||
      contents.session !== session ||
      routers.has(contents.id)
    )
      return;
    const router = new AccountRouter(
      contents,
      origin,
      (event) => report(session, event),
      () => report(session, "account-routing-detached"),
    );
    routers.set(contents.id, { router, session });
    contents.once("destroyed", () => {
      routers.delete(contents.id);
    });
    try {
      await router.start();
    } catch (error) {
      routers.delete(contents.id);
      report(session, "account-routing-detached");
      throw error;
    }
  }
  const created = (_event, contents) => {
    const lease = [...leases.values()].find(
      (x) => x.session === contents.session,
    );
    if (lease) attach(contents, lease.session, lease.origin).catch(() => {});
  };
  async function release(token) {
    const lease = leases.get(token);
    if (!lease) return;
    leases.delete(token);
    const owner = webContents.fromId(lease.ownerID);
    if (owner && !owner.isDestroyed())
      owner.removeListener("destroyed", lease.destroyed);
    if (![...leases.values()].some((x) => x.session === lease.session))
      for (const [id, entry] of routers)
        if (entry.session === lease.session) {
          routers.delete(id);
          await entry.router.stop();
        }
    if (leases.size === 0 && watching) {
      app.removeListener("web-contents-created", created);
      watching = false;
    }
  }
  return {
    protocol: 1,
    acquire(ownerID, origin, event) {
      return serial(async () => {
        const owner = webContents.fromId(ownerID);
        if (!owner) throw new Error("The plugin window is unavailable.");
        const session = owner.session;
        if (
          [...leases.values()].some(
            (x) => x.session === session && x.origin !== origin,
          )
        )
          throw new Error(
            "Another window in this profile uses a different custom server.",
          );
        const token = randomBytes(24).toString("hex");
        const destroyed = () => {
          serial(() => release(token)).catch(() => {});
        };
        leases.set(token, {
          ownerID,
          session,
          origin,
          event,
          active: true,
          destroyed,
        });
        owner.once("destroyed", destroyed);
        if (!watching) {
          app.on("web-contents-created", created);
          watching = true;
        }
        try {
          for (const contents of webContents.getAllWebContents())
            if (contents.session === session)
              await attach(contents, session, origin);
        } catch (error) {
          await release(token);
          throw error;
        }
        return token;
      });
    },
    status(token) {
      const lease = leases.get(token);
      return { active: !!lease?.active };
    },
    release(token) {
      return serial(() => release(token));
    },
  };
}
if (!globalThis[KEY]) globalThis[KEY] = makeCoordinator();
module.exports = globalThis[KEY];
