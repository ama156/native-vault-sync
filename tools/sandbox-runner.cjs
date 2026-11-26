"use strict";
// Run ONLY with a separate Electron runtime and sandbox copies of app resources.
// The private command channel is for integration tests in this disposable app.
const electron = require("electron"),
  { app, protocol } = electron,
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  { EventEmitter } = require("node:events");
const sandbox = process.env.SYNC_TEST_SANDBOX,
  bundle = process.env.OBSIDIAN_TEST_ASAR,
  bootstrap = process.env.SYNC_TEST_BOOTSTRAP_ASAR,
  server = process.env.SYNC_TEST_SERVER,
  label = process.env.SYNC_TEST_PROFILE || "a";
if (
  !sandbox ||
  !bundle ||
  !bootstrap ||
  !server ||
  !path.isAbsolute(sandbox) ||
  !/^[-a-z0-9]{1,32}$/.test(label)
)
  throw Error(
    "Supply sandbox, copied ASAR resources, loopback server, and a simple test profile label.",
  );
for (const file of [bundle, bootstrap])
  if (fs.realpathSync(file).startsWith("/Applications/"))
    throw Error(
      "Installed app resources cannot be used as the test runtime. Copy them into the sandbox first.",
    );
if (new URL(server).hostname !== "127.0.0.1")
  throw Error("The integration harness requires a disposable loopback server.");
fs.mkdirSync(sandbox, { recursive: true, mode: 0o700 });
const marker = path.join(sandbox, ".vault-sync-sandbox");
if (!fs.existsSync(marker)) {
  if (fs.readdirSync(sandbox).length)
    throw Error("Refusing to use an existing non-sandbox directory.");
  fs.writeFileSync(marker, "vault-sync-disposable-v1", { mode: 0o600 });
} else if (fs.readFileSync(marker, "utf8") !== "vault-sync-disposable-v1")
  throw Error("Invalid sandbox marker");
const profile = path.join(sandbox, "profile-" + label),
  vault = path.join(sandbox, "vault-" + label),
  config = path.join(vault, ".obsidian"),
  plugin = path.join(config, "plugins/vault-sync-bridge"),
  root = path.resolve(__dirname, "..");
fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
fs.mkdirSync(plugin, { recursive: true, mode: 0o700 });
const assets = process.env.SYNC_TEST_PLUGIN_ASSETS || path.join(root, "plugin/dist");
for (const f of ["main.js", "manifest.json"])
  fs.copyFileSync(path.join(assets, f), path.join(plugin, f));
if (!fs.existsSync(path.join(plugin, "data.json")))
  fs.writeFileSync(
    path.join(plugin, "data.json"),
    JSON.stringify(process.env.SYNC_TEST_MAC_DIRECT === "1"
      ? { macDirect: { server } }
      : { server, enabled: true, accountBinding: server }),
    { mode: 0o600 },
  );
fs.writeFileSync(
  path.join(config, "community-plugins.json"),
  '["vault-sync-bridge"]',
);
fs.writeFileSync(
  path.join(config, "core-plugins.json"),
  '["file-explorer","command-palette","sync"]',
);
fs.writeFileSync(
  path.join(profile, "obsidian.json"),
  JSON.stringify({
    updateDisabled: true,
    disableGpu: true,
    vaults: { ["test" + label]: { path: vault, ts: Date.now(), open: true } },
  }),
);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sync-home-"));
os.homedir = () => home;
app.setPath("home", home);
app.setAppPath(bootstrap);
app.setPath("userData", profile);
app.setPath("documents", sandbox);
app.setPath("desktop", sandbox);
app.setName("Vault Sync Disposable " + label);
app.isDefaultProtocolClient = () => true;
const remote = require(
  path.join(bootstrap, "node_modules/@electron/remote/main"),
);
remote.initialize();
electron.remote = remote;
app.on("web-contents-created", (_, contents) => remote.enable(contents));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);
require(path.join(bundle, "main.js"))(bundle, new EventEmitter(), false);
let last = null,
  busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  const main = electron.BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.getURL().includes("/index.html"),
  );
  if (!main) return;
  const file = path.join(sandbox, "command-" + label + ".json");
  if (!fs.existsSync(file)) return;
  const command = JSON.parse(fs.readFileSync(file, "utf8"));
  if (command.id === last) return;
  last = command.id;
  busy = true;
  try {
    const target =
      command.target === "settings"
        ? electron.BrowserWindow.getAllWindows().find((w) =>
            w.getTitle().startsWith("Settings"),
          )
        : main;
    if (!target) throw Error("Requested test window unavailable");
    const value = await target.webContents.executeJavaScript(command.code);
    fs.writeFileSync(
      path.join(sandbox, "result-" + label + ".json"),
      JSON.stringify({ id: last, value }),
      { mode: 0o600 },
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(sandbox, "result-" + label + ".json"),
      JSON.stringify({ id: last, error: error.message }),
      { mode: 0o600 },
    );
  } finally {
    busy = false;
  }
}, 200);
app.on("will-quit", () => {
  clearInterval(timer);
  fs.rmSync(home, { recursive: true, force: true });
});
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
