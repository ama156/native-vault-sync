const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
function go(args) {
  const r = spawnSync("go", args, {
    cwd: path.join(root, "server"),
    encoding: "utf8",
  });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout;
}
const ownModule = go(["list", "-m"]).trim();
const modules = new Map();
for (const line of go([
  "list",
  "-deps",
  "-f",
  "{{if .Module}}{{.Module.Path}}|{{.Module.Dir}}{{end}}",
  "./cmd/vault-sync-server",
]).split("\n")) {
  const [name, dir] = line.trim().split("|");
  if (name && dir && name !== ownModule) modules.set(name, dir);
}
let text =
  "# Third-party notices\n\nThe project source is MIT-licensed. Bundled or compiled dependencies retain the licenses reproduced below. The development harness loads a separately supplied client bundle only at test time; no proprietary client code is shipped.\n\n";
const append = (name, file) => {
  text +=
    "## " +
    name +
    "\n\n```text\n" +
    fs.readFileSync(file, "utf8").trim() +
    "\n```\n\n";
};
append(
  "ws — embedded plugin WebSocket transport",
  path.join(root, "node_modules/ws/LICENSE"),
);
for (const [name, dir] of [...modules].sort()) {
  const file = ["LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING"]
    .map((f) => path.join(dir, f))
    .find((f) => fs.existsSync(f));
  if (!file) throw Error("Missing license for " + name);
  append(name, file);
}
const goLicense = path.join(go(["env", "GOROOT"]).trim(), "LICENSE");
append(
  "Go runtime and standard library",
  fs.existsSync(goLicense) ? goLicense : path.join(root, "licenses/Go-LICENSE"),
);
text +=
  "Build-only npm tools are installed separately through npm; their licenses are in their packages. This release includes no original client implementation or assets.\n";
fs.writeFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), text);
console.log(
  "Generated notices for ws, " +
    modules.size +
    " Go modules, and the Go runtime.",
);
