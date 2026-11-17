"use strict";
// Plugin-only prerelease packaging. Does not build or modify the server.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
if (manifest.isDesktopOnly !== false)
  throw Error(
    "Mobile diagnostic installation must be enabled in the manifest.",
  );
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw Error(command + " failed");
}
run(process.execPath, [path.join(root, "tools/build-plugin.cjs")]);
const output = path.join(root, "releases", "plugin-" + manifest.version);
fs.mkdirSync(output, { recursive: true });
for (const file of ["main.js", "manifest.json"]) {
  fs.copyFileSync(
    path.join(root, "plugin/dist", file),
    path.join(output, file),
  );
}
fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
fs.copyFileSync(
  path.join(root, "docs/MOBILE-STATUS.md"),
  path.join(output, "MOBILE-STATUS.md"),
);
fs.copyFileSync(
  path.join(root, "docs/mobile-diagnostic-tests.json"),
  path.join(output, "mobile-diagnostic-tests.json"),
);
const files = [
  "main.js",
  "manifest.json",
  "LICENSE",
  "MOBILE-STATUS.md",
  "mobile-diagnostic-tests.json",
];
const archive = `vault-sync-bridge_${manifest.version}_mobile-diagnostic.zip`;
fs.rmSync(path.join(output, archive), { force: true });
run("zip", ["-q", archive, ...files], output);
const sums =
  [...files, archive]
    .sort()
    .map(
      (file) =>
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(output, file)))
          .digest("hex") +
        "  " +
        file,
    )
    .join("\n") + "\n";
fs.writeFileSync(path.join(output, "SHA256SUMS"), sums);
console.log("Diagnostic prerelease artifacts: " + output);
