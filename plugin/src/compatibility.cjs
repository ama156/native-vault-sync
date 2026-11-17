"use strict";

const DESKTOP_VERSIONS = new Set(["1.8.7", "1.15.1"]);

function platformName(platform = {}) {
  if (platform.isIosApp) return "ios";
  if (platform.isAndroidApp) return "android";
  if (platform.isMobile) return "mobile-unknown";
  if (!platform.isDesktopApp) return "unknown";
  if (platform.isMacOS) return "macos";
  if (platform.isWin) return "windows";
  if (platform.isLinux) return "linux";
  return "desktop-unknown";
}

function compatibility(platform, version) {
  const name = platformName(platform);
  const desktop =
    name === "macos" ||
    name === "windows" ||
    name === "linux" ||
    name === "desktop-unknown";
  const available = desktop && DESKTOP_VERSIONS.has(version);
  return {
    platform: name,
    appVersion: String(version || "unknown"),
    adapter: desktop ? "desktop" : "mobile-diagnostics",
    syncAdapterAvailable: available,
    qualification:
      available && name === "macos"
        ? "copied-app-bundle-sandbox-tested"
        : "unqualified",
    experimentalIOSAdapterAvailable: name === "ios" && version === "1.15.1",
    mobileAccountGate:
      name === "ios" && version === "1.15.1"
        ? "isolated-source-proof-passed; device-test-pending"
        : "not-established",
  };
}

module.exports = { DESKTOP_VERSIONS, platformName, compatibility };
