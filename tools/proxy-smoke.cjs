"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process"),
  net = require("node:net"),
  https = require("node:https"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { once } = require("node:events"),
  { WebSocket } = require("ws");
async function main() {
  const binary = process.env.SYNC_TEST_BINARY,
    nginx = process.env.SYNC_TEST_NGINX || "nginx";
  if (
    !binary ||
    !path.isAbsolute(binary) ||
    binary.startsWith("/Applications/")
  )
    throw Error("Supply an isolated test server binary");
  const root = fs.mkdtempSync("/tmp/vs-proxy-"),
    domain = "obsidianvault.example.com",
    checks = [];
  let server, proxy, socket;
  const run = (file, args, input) => {
    const r = cp.spawnSync(file, args, { input, encoding: "utf8" });
    if (r.status !== 0)
      throw Error(path.basename(file) + " failed: " + r.stderr.slice(0, 200));
    return r.stdout;
  };
  const port = async () => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  };
  try {
    const backend = await port(),
      tls = await port(),
      http = await port(),
      config = path.join(root, "config.json"),
      key = path.join(root, "key.pem"),
      cert = path.join(root, "cert.pem"),
      password = crypto.randomBytes(24).toString("hex");
    run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=" + domain,
      "-addext",
      "subjectAltName=DNS:" + domain + ",IP:127.0.0.1",
    ]);
    run(
      binary,
      [
        "init",
        "--config",
        config,
        "--data-dir",
        path.join(root, "data"),
        "--listen",
        "127.0.0.1:" + backend,
        "--public-url",
        "https://" + domain + ":" + tls,
        "--email",
        "proxy@local.invalid",
        "--password-stdin",
      ],
      password + "\n",
    );
    const cfg = JSON.parse(fs.readFileSync(config));
    cfg.trusted_proxies = ["127.0.0.1/32"];
    cfg.login_ip_per_minute = 2;
    fs.writeFileSync(config, JSON.stringify(cfg));
    server = cp.spawn(binary, ["serve", "--config", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error("Backend timeout")), 10000);
      server.stderr.on("data", (d) => {
        if (d.toString().includes("server ready")) {
          clearTimeout(t);
          resolve();
        }
      });
      server.once("exit", () => {
        clearTimeout(t);
        reject(Error("Backend exited"));
      });
    });
    const deploy = path.resolve(__dirname, "../deploy");
    let site = fs
      .readFileSync(path.join(deploy, "nginx.conf"), "utf8")
      .replace("listen 80;", "listen 127.0.0.1:" + http + ";")
      .replace("listen 443 ssl;", "listen 127.0.0.1:" + tls + " ssl;")
      .replaceAll("/etc/letsencrypt/live/" + domain + "/fullchain.pem", cert)
      .replaceAll("/etc/letsencrypt/live/" + domain + "/privkey.pem", key)
      .replaceAll(
        "/etc/nginx/snippets/vault-sync-proxy.conf",
        path.join(root, "proxy.conf"),
      )
      .replace(
        "/var/log/nginx/vault-sync-access.log",
        path.join(root, "access.log"),
      );
    fs.writeFileSync(
      path.join(root, "proxy.conf"),
      fs
        .readFileSync(path.join(deploy, "vault-sync-proxy.conf"), "utf8")
        .replace("127.0.0.1:8080", "127.0.0.1:" + backend),
    );
    fs.writeFileSync(
      path.join(root, "nginx.conf"),
      "pid " +
        root +
        "/nginx.pid;\nevents {worker_connections 128;}\nhttp {client_body_temp_path " +
        root +
        "/body;proxy_temp_path " +
        root +
        "/proxy;error_log " +
        root +
        "/error.log;\n" +
        site +
        "\n}\n",
    );
    run(nginx, ["-p", root + "/", "-c", path.join(root, "nginx.conf"), "-t"]);
    proxy = cp.spawn(
      nginx,
      [
        "-p",
        root + "/",
        "-c",
        path.join(root, "nginx.conf"),
        "-g",
        "daemon off;",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const ca = fs.readFileSync(cert);
    const request = (route, body, headers = {}) =>
      new Promise((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = https.request(
          {
            host: "127.0.0.1",
            port: tls,
            servername: domain,
            ca,
            path: route,
            method: data ? "POST" : "GET",
            headers: {
              Host: domain + ":" + tls,
              ...(data
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                  }
                : {}),
              ...headers,
            },
            timeout: 5000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString();
              let json;
              try {
                json = JSON.parse(raw);
              } catch {}
              resolve({ status: res.statusCode, headers: res.headers, json });
            });
          },
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(Error("HTTPS timeout")));
        req.end(data);
      });
    let health;
    for (let i = 0; i < 100; i++) {
      try {
        health = await request("/healthz");
        if (health.status === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(health?.status, 200);
    assert.ok(health.headers["strict-transport-security"]);
    checks.push(
      "Production Nginx template validates and serves HTTPS with a specifically trusted disposable test certificate",
    );
    assert.equal(
      (await request("/healthz", undefined, { Origin: "https://evil.invalid" }))
        .status,
      403,
    );
    assert.equal(
      (await request("/user/signin", { password: "x".repeat(66000) })).status,
      413,
    );
    const login = await request("/user/signin", {
      email: "proxy@local.invalid",
      password,
    });
    assert.equal(login.status, 200);
    const token = login.json.token;
    assert.ok(token);
    const vault = (
      await request("/vault/create", {
        token,
        name: "Proxy test",
        salt: "synthetic",
        keyhash: "synthetic",
        encryption_version: 3,
      })
    ).json;
    assert.ok(vault.id);
    socket = new WebSocket("wss://127.0.0.1:" + tls + "/sync", {
      ca,
      servername: domain,
      headers: { Host: domain + ":" + tls, Origin: "capacitor://localhost" },
    });
    const queue = [],
      waiters = [];
    socket.on("message", (d, b) => {
      const x = b ? d : JSON.parse(d.toString());
      if (waiters.length) waiters.shift()(x);
      else queue.push(x);
    });
    const next = () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : Promise.race([
            new Promise((r) => waiters.push(r)),
            new Promise((_, reject) => {
              const t = setTimeout(() => reject(Error("WS timeout")), 10000);
              t.unref();
            }),
          ]);
    const response = async () => {
      let x;
      do {
        x = await next();
      } while (x.op);
      return x;
    };
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        op: "init",
        token,
        id: vault.id,
        keyhash: "synthetic",
        encryption_version: 3,
        initial: true,
      }),
    );
    assert.equal((await response()).res, "ok");
    assert.equal((await next()).op, "ready");
    const bytes = crypto.randomBytes(2097152 + 33);
    socket.send(
      JSON.stringify({
        op: "push",
        path: "opaque-path",
        hash: "opaque-hash",
        size: bytes.length,
        pieces: 2,
      }),
    );
    assert.equal((await response()).res, "upload");
    for (let i = 0; i < bytes.length; i += 2097152) {
      socket.send(bytes.subarray(i, i + 2097152));
      assert.equal((await response()).res, "ok");
    }
    socket.send(JSON.stringify({ op: "pull", uid: 1 }));
    const meta = await response();
    assert.equal(meta.pieces, 2);
    assert.deepEqual(Buffer.concat([await next(), await next()]), bytes);
    checks.push(
      "HTTPS account API and iOS-Origin WebSocket pass >2 MiB ciphertext through Nginx despite the 64 KiB HTTP body limit",
    );
    await request(
      "/user/signin",
      { email: "proxy@local.invalid", password: "wrong password" },
      { "X-Forwarded-For": "198.51.100.1" },
    );
    const limited = await request(
      "/user/signin",
      { email: "proxy@local.invalid", password: "wrong password" },
      { "X-Forwarded-For": "198.51.100.2" },
    );
    assert.equal(limited.status, 429);
    checks.push(
      "Untrusted Origin/oversized HTTP bodies are rejected; spoofed forwarding headers cannot evade login-IP throttling",
    );
    return {
      status: "passed",
      checks,
      limits: [
        "Disposable certificate trusted only by this test; production plugin certificate validation remains unchanged.",
        "Loopback proxy/server and synthetic ciphertext; no installed Obsidian app or real data.",
      ],
    };
  } finally {
    socket?.terminate();
    for (const child of [proxy, server])
      if (child && child.exitCode === null) {
        const p = once(child, "exit");
        child.kill("SIGTERM");
        await p;
      }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main()
  .then((r) => {
    const text = JSON.stringify(r, null, 2) + "\n";
    if (process.env.SYNC_PROXY_TEST_REPORT)
      fs.writeFileSync(process.env.SYNC_PROXY_TEST_REPORT, text);
    process.stdout.write(text);
  })
  .catch((e) => {
    process.stderr.write(e.message + "\n");
    process.exitCode = 1;
  });
