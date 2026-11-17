"use strict";

// Development diagnostics only. No getters, native Sync operations, account
// storage, networking, or file APIs are invoked. Function bodies never leave
// this function; the report contains hashes and structural observations only.
const { compatibility } = require("./compatibility.cjs");

function property(object, name) {
  let target = object;
  for (let depth = 0; target && depth < 10; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      const data = Object.hasOwn(descriptor, "value");
      return {
        value: data ? descriptor.value : undefined,
        metadata: {
          found: true,
          depth,
          dataProperty: data,
          writable: data ? !!descriptor.writable : null,
          configurable: !!descriptor.configurable,
          hasGetter: typeof descriptor.get === "function",
          hasSetter: typeof descriptor.set === "function",
        },
      };
    }
    target = Object.getPrototypeOf(target);
  }
  return { value: undefined, metadata: { found: false } };
}

async function methodReport(owner, name, runtime) {
  const result = property(owner, name);
  const fn = result.value;
  const report = { ...result.metadata, callable: typeof fn === "function" };
  if (!report.callable) return report;
  const source = Function.prototype.toString.call(fn);
  report.sourceLength = source.length;
  report.opaqueNativeFunction = source.includes("[native code]");
  report.mentionsAccountToken = /\b[A-Za-z_$][\w$]*\.token\b/.test(source);
  report.mentionsOfficialDomain = source.includes("obsidian.md");
  report.sourceSha256 = null;
  if (runtime.subtle && runtime.TextEncoder) {
    try {
      const digest = await runtime.subtle.digest(
        "SHA-256",
        new runtime.TextEncoder().encode(source),
      );
      report.sourceSha256 = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } catch {
      // Some mobile runtimes lack this capability. Never substitute raw source.
    }
  }
  return report;
}

async function collectReport({
  app,
  platform,
  appVersion,
  pluginVersion,
  runtime = {},
}) {
  const report = {
    schema: "vault-sync-bridge.mobile-diagnostics.v1",
    pluginVersion,
    ...compatibility(platform, appVersion),
    generatedAt: new Date().toISOString(),
    mode: "read-only-diagnostics",
    routingActive: false,
    capabilities: {
      browserWebSocket: !!runtime.hasWebSocket,
      webCryptoDigest: !!runtime.subtle,
    },
    native: { found: false },
    limitations: [
      "No mobile session adapter is device-qualified; this report does not activate one.",
      "Method hashes are not a full app-bundle fingerprint or a compatibility proof.",
      "Token references are source observations, not account values or authorization checks.",
    ],
  };
  const manager = property(app, "internalPlugins").value;
  const getPlugin = property(manager, "getPluginById").value;
  if (typeof getPlugin !== "function") return report;
  // This existing registry accessor only locates the plugin. Do not enable it.
  const plugin = getPlugin.call(manager, "sync");
  const native = property(plugin, "instance").value;
  if (!native) return report;
  const server = property(native, "server");
  report.native = {
    found: true,
    enabled: property(plugin, "enabled").value === true,
    extensible: Object.isExtensible(native),
    server: {
      ...server.metadata,
      instanceAvailable: !!server.value,
      extensible: server.value ? Object.isExtensible(server.value) : null,
    },
    engineMethods: {},
    transportMethods: {},
  };
  for (const name of [
    "getHost",
    "setup",
    "connectToVault",
    "getServer",
    "asyncGetServer",
    "_sync",
  ]) {
    report.native.engineMethods[name] = await methodReport(
      native,
      name,
      runtime,
    );
  }
  for (const name of [
    "connect",
    "disconnect",
    "hasConnection",
    "onMessage",
    "send",
  ]) {
    report.native.transportMethods[name] = await methodReport(
      server.value,
      name,
      runtime,
    );
  }
  return report;
}

module.exports = { collectReport };
