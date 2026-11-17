const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { load187 } = require("./native-runtime.cjs");
const archive = process.env.OBSIDIAN_TEST_ASAR,
  base = process.env.SYNC_TEST_SERVER;
if (!archive || !base || new URL(base).hostname !== "127.0.0.1")
  throw Error(
    "Set OBSIDIAN_TEST_ASAR to a sandbox copy and SYNC_TEST_SERVER to a disposable loopback server.",
  );
const password = process.env.SYNC_TEST_PASSWORD;
if (!password) throw Error("Set SYNC_TEST_PASSWORD for the disposable owner");
const until = async (fn) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 10000) throw Error("Native event timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
async function post(route, body) {
  const r = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok || result.error) throw Error(result.error || route);
  return result;
}
(async () => {
  const { Transport, provider, derive, version, sha256 } = load187(archive);
  const account = await post("/user/signin", {
    email: "bridge@local.invalid",
    password,
    mfa: "",
  });
  const reports = [];
  for (const v of [0, 2, 3]) {
    const checks = [];
    const salt = "native-contract-salt-" + v,
      key = await derive("Disposable encryption password", salt),
      pa = await provider(v, key, salt),
      pb = await provider(v, key, salt);
    const vault = await post("/vault/create", {
      token: account.token,
      name: "Native contract v" + v,
      keyhash: pa.keyHash,
      salt,
      encryption_version: v,
      region: "self-hosted",
    });
    const a = new Transport(pa),
      b = new Transport(pb),
      pushes = [];
    let ra = false,
      rb = false;
    try {
      let rejected = false;
      try {
        await a.connect(
          "wss://unrelated.invalid",
          account.token,
          vault.id,
          0,
          true,
          "A",
          () => {},
          () => {},
        );
      } catch {
        rejected = true;
      }
      assert.ok(rejected);
      checks.push("hostname guard");
      await a.connect(
        base.replace(/^http/, "ws") + "/sync",
        account.token,
        vault.id,
        0,
        true,
        "A",
        () => {
          ra = true;
        },
        () => {},
      );
      await b.connect(
        base.replace(/^http/, "ws") + "/sync",
        account.token,
        vault.id,
        0,
        true,
        "B",
        () => {
          rb = true;
        },
        (m) => pushes.push(m),
      );
      await until(() => ra && rb);
      checks.push("native login and ready");
      const body = new TextEncoder().encode(
        "# A native compatibility note\nOnly encrypted bytes reach the backend.",
      ).buffer;
      const now = Date.now();
      await a.push(
        "Native proof.md",
        null,
        false,
        false,
        now,
        now,
        "opaque-content-hash",
        body,
      );
      await until(() => pushes.some((m) => m.path === "Native proof.md"));
      const first = pushes.find((m) => m.path === "Native proof.md").uid;
      assert.equal(
        new TextDecoder().decode(await b.pull(first)),
        new TextDecoder().decode(body),
      );
      checks.push("native crypto round trip");
      const large = crypto.randomBytes(2097152 + 4096);
      await a.push(
        "Large.png",
        null,
        false,
        false,
        now,
        now,
        "large-content-hash",
        Uint8Array.from(large).buffer,
      );
      await until(() => pushes.some((m) => m.path === "Large.png"));
      assert.deepEqual(
        Buffer.from(
          await b.pull(pushes.find((m) => m.path === "Large.png").uid),
        ),
        large,
      );
      checks.push("ordered multi-piece transfer");
      const history = await a.listHistory("Native proof.md", 0);
      assert.ok(history.items.some((m) => m.uid === first));
      await a.push(
        "Native proof.md",
        null,
        false,
        true,
        0,
        0,
        "",
        new ArrayBuffer(0),
      );
      await until(() =>
        pushes.some((m) => m.path === "Native proof.md" && m.deleted),
      );
      assert.ok(
        (await b.listDeleted()).some((m) => m.path === "Native proof.md"),
      );
      await b.restore(first);
      await until(
        () =>
          pushes.filter((m) => m.path === "Native proof.md" && !m.deleted)
            .length >= 2,
      );
      checks.push("native history delete restore");
      const cursor = pushes.at(-1).uid;
      b.disconnect();
      await a.push(
        "Offline.md",
        null,
        false,
        false,
        now,
        now,
        "offline-hash",
        body,
      );
      const resumed = [];
      let rc = false;
      const c = new Transport(pb);
      try {
        await c.connect(
          base.replace(/^http/, "ws") + "/sync",
          account.token,
          vault.id,
          cursor,
          false,
          "B resumed",
          () => {
            rc = true;
          },
          (m) => resumed.push(m),
        );
        await until(() => rc);
        assert.ok(resumed.some((m) => m.path === "Offline.md"));
        assert.ok(resumed.every((m) => m.uid > cursor));
        checks.push("cursor replay");
      } finally {
        c.disconnect();
      }
      reports.push({ encryptionVersion: v, status: "passed", checks });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  }
  const result = {
    status: "passed",
    client: version,
    sourceSha256: sha256,
    mode: "real loopback sockets against Go server; browser-task message delivery adapter",
    reports,
    at: new Date().toISOString(),
  };
  if (process.env.SYNC_TEST_REPORT)
    fs.writeFileSync(
      process.env.SYNC_TEST_REPORT,
      JSON.stringify(result, null, 2),
    );
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
