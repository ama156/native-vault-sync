"use strict";

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const manifest = require("../manifest.json");

const output = path.resolve(__dirname, "../releases/0.2.1");
const build = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, "../plugin/src/mac-prerelease.cjs")],
  outfile: path.join(output, "main.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian"],
  metafile: true,
});
for (const input of Object.keys(build.metafile.inputs)) {
  if (/(?:^|\/)(?:relay|account-router|main-coordinator|connection-bootstrap)\.cjs$/.test(input))
    throw Error("Desktop routing entered the Direct Sync prerelease.");
}
fs.writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify({ ...manifest, version: "0.2.1", minAppVersion: "1.15.1", isDesktopOnly: true }, null, 2) + "\n",
);
