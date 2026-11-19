"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "releases"),
  version = require("../manifest.json").version;
fs.mkdirSync(out, { recursive: true });
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (r.status !== 0) throw new Error(command + " failed");
}
run(process.execPath, [path.join(__dirname, "build-plugin.cjs")]);
for (const arch of ["amd64", "arm64"]) {
  const staging = path.join(out, "linux-" + arch);
  fs.mkdirSync(staging, { recursive: true });
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      path.join(staging, "vault-sync-server"),
      "./cmd/vault-sync-server",
    ],
    {
      cwd: path.join(root, "server"),
      env: {
        ...process.env,
        GOTOOLCHAIN: "go1.27.4",
        CGO_ENABLED: "0",
        GOOS: "linux",
        GOARCH: arch,
      },
    },
  );
  for (const f of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    fs.copyFileSync(path.join(root, f), path.join(staging, f));
  fs.cpSync(path.join(root, "deploy"), path.join(staging, "deploy"), {
    recursive: true,
  });
  fs.cpSync(path.join(root, "docs"), path.join(staging, "docs"), {
    recursive: true,
  });
  run("tar", [
    "-czf",
    path.join(out, `vault-sync-server_${version}_linux_${arch}.tar.gz`),
    "-C",
    staging,
    ".",
  ]);
}
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const source = path.join(root, "plugin/dist", file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(out, file));
}
const pluginFiles = ["main.js", "manifest.json", "styles.css"].filter((f) =>
  fs.existsSync(path.join(out, f)),
);
run("zip", [
  "-q",
  "-j",
  path.join(out, `vault-sync-bridge_${version}.zip`),
  ...pluginFiles.map((f) => path.join(out, f)),
]);
const source = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "manifest.json",
  "versions.json",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".dockerignore",
  ".env.example",
  "Dockerfile",
  "compose.yaml",
  "compose.proxy.yaml",
  "compose.secrets.yaml",
  "server/go.mod",
  "server/go.sum",
  "server/LICENSE",
];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "releases",
        "dist",
        ".git",
        ".DS_Store",
        "work",
        ".data",
      ].includes(entry.name)
    )
      continue;
    const f = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(f);
    else source.push(path.relative(root, f));
  }
}
for (const dir of [
  "server/cmd",
  "server/internal",
  "plugin/src",
  "plugin/test",
  "tools",
  "docs",
  "licenses",
  ".github",
  "deploy",
])
  walk(path.join(root, dir));
run("zip", [
  "-q",
  path.join(out, `vault-sync-source_${version}.zip`),
  ...source,
]);
const files = fs
  .readdirSync(out)
  .filter((f) => fs.statSync(path.join(out, f)).isFile() && f !== "SHA256SUMS")
  .sort();
const sums =
  files
    .map(
      (f) =>
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(out, f)))
          .digest("hex") +
        "  " +
        f,
    )
    .join("\n") + "\n";
fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
console.log("Release artifacts prepared in releases/");
