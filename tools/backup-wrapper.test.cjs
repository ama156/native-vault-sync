"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
for (const failure of ["none", "snapshot", "restic"])
  test("backup wrapper restart and retention: " + failure, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vs-wrapper-")),
      bin = path.join(temp, "bin"),
      root = path.join(temp, "backups"),
      trace = path.join(temp, "trace");
    fs.mkdirSync(bin);
    const executable = (name, body) => {
      const p = path.join(bin, name);
      fs.writeFileSync(p, "#!/usr/bin/env bash\nset -eu\n" + body, {
        mode: 0o755,
      });
      return p;
    };
    executable("id", "if [[ $# = 1 ]]; then echo 0; else echo 10001; fi\n");
    executable("chown", "exit 0\n");
    executable("flock", "exit 0\n");
    executable(
      "runuser",
      'while [[ $1 != -- ]]; do shift; done\nshift\nexec "$@"\n',
    );
    executable(
      "systemctl",
      'if [[ $1 != is-active ]]; then echo "$1" >> "$VS_WRAPPER_TRACE"; fi\n',
    );
    const binary = executable(
      "test-server",
      'echo snapshot >> "$VS_WRAPPER_TRACE"\nwhile [[ $1 != --output ]]; do shift; done\nmkdir -p "$2"\n[[ $VS_WRAPPER_FAILURE != snapshot ]] || exit 1\nprintf \'{}\' > "$2/manifest.json"\n',
    );
    executable(
      "restic",
      'echo restic >> "$VS_WRAPPER_TRACE"\n[[ $VS_WRAPPER_FAILURE != restic ]]\n',
    );
    try {
      const result = spawnSync(
        "bash",
        [path.resolve(__dirname, "../deploy/backup-restic.sh")],
        {
          env: {
            ...process.env,
            PATH: bin + path.delimiter + process.env.PATH,
            VAULT_SYNC_BACKUP_ROOT: root,
            VAULT_SYNC_BINARY: binary,
            RESTIC_REPOSITORY: "/unused-test-repository",
            RESTIC_PASSWORD_FILE: "/unused-test-password",
            VS_WRAPPER_TRACE: trace,
            VS_WRAPPER_FAILURE: failure,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, failure === "none" ? 0 : 1, result.stderr);
      const events = fs.readFileSync(trace, "utf8").trim().split("\n");
      assert.deepEqual(
        events,
        failure === "snapshot"
          ? ["stop", "snapshot", "start"]
          : ["stop", "snapshot", "start", "restic"],
      );
      const jobs = fs.readdirSync(root).filter((n) => n.startsWith("job-"));
      assert.equal(jobs.length, failure === "none" ? 0 : 1);
      if (failure === "restic")
        assert.ok(
          fs.existsSync(path.join(root, jobs[0], "snapshot/manifest.json")),
        );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
