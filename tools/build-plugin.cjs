const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "plugin", "dist");
fs.mkdirSync(out, { recursive: true });
// A separate browser build makes accidental mobile imports of Node/Electron
// a build error. Only the usual bundled main.js is distributed.
esbuild.buildSync({
  entryPoints: [path.join(root, "plugin", "src", "ios-main.cjs")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  write: false,
});
esbuild.buildSync({
  entryPoints: [path.join(root, "plugin", "src", "entry.cjs")],
  outfile: path.join(out, "main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2020",
  external: [
    "obsidian",
    "electron",
    "@electron/remote",
    "bufferutil",
    "utf-8-validate",
  ],
  legalComments: "eof",
  minify: false,
});
for (const f of ["manifest.json", "styles.css"]) {
  const source =
    f === "manifest.json" ? path.join(root, f) : path.join(root, "plugin", f);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(out, f));
}
const notice =
  "\n/*\nVault Sync Bridge — MIT license\n" +
  fs.readFileSync(path.join(root, "LICENSE"), "utf8") +
  "\nBundled ws dependency — MIT license\n" +
  fs.readFileSync(path.join(root, "node_modules/ws/LICENSE"), "utf8") +
  "\n*/\n";
fs.appendFileSync(path.join(out, "main.js"), notice);
console.log("Built plugin/dist");
