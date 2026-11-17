"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { setTimeout } = require("node:timers");
const { WebSocket, WebSocketServer } = require("ws");
const CHUNK = 2097152;

function validateServer(value) {
  const url = new URL(value);
  const development = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (
    (!development && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use an HTTPS server origin, without a path, credentials, query, or fragment.",
    );
  }
  return url.origin;
}

class Relay {
  constructor(server, event = () => {}) {
    this.serverOrigin = validateServer(server);
    this.upstream = this.serverOrigin.replace(/^http/, "ws") + "/sync";
    this.path = "/" + crypto.randomBytes(32).toString("hex");
    this.event = event;
    this.pairs = new Set();
  }
  async start() {
    this.http = http.createServer((req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: CHUNK,
      perMessageDeflate: false,
    });
    this.http.on("upgrade", (req, socket, head) => {
      if (req.url !== this.path || this.pairs.size >= 8) {
        socket.destroy();
        return;
      }
      const remote = new WebSocket(this.upstream, {
        maxPayload: CHUNK,
        perMessageDeflate: false,
        handshakeTimeout: 15000,
      });
      const pair = { remote, local: null, socket };
      this.pairs.add(pair);
      let closing = false;
      const finish = (code = 1011) => {
        if (closing) return;
        closing = true;
        for (const ws of [remote, pair.local]) {
          if (ws?.readyState === WebSocket.OPEN) ws.close(code);
          else if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }
        if (!pair.local) socket.destroy();
        this.pairs.delete(pair);
        const timer = setTimeout(() => {
          remote.terminate();
          pair.local?.terminate();
        }, 1000);
        timer.unref();
      };
      socket.on("error", () => finish());
      socket.on("close", () => {
        if (!pair.local) finish();
      });
      remote.on("error", () => {
        this.event("upstream-error");
        finish();
      });
      remote.on("close", (code) => finish(code === 1000 ? 1000 : 1011));
      remote.once("open", () => {
        if (closing || socket.destroyed) {
          finish();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (local) => {
          pair.local = local;
          const forward = (target, bytes, binary) => {
            if (
              target.readyState !== WebSocket.OPEN ||
              target.bufferedAmount + bytes.length > 8 * CHUNK
            ) {
              finish();
              return;
            }
            target.send(bytes, { binary }, (error) => {
              if (error) finish();
            });
          };
          local.on("message", (bytes, binary) =>
            forward(remote, bytes, binary),
          );
          remote.on("message", (bytes, binary) =>
            forward(local, bytes, binary),
          );
          local.on("error", () => finish());
          local.on("close", (code) => finish(code === 1000 ? 1000 : 1011));
          this.event("relay-connected");
        });
      });
    });
    await new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(0, "127.0.0.1", resolve);
    });
    this.url = "ws://127.0.0.1:" + this.http.address().port + this.path;
    return this.url;
  }
  async stop() {
    for (const pair of this.pairs) {
      pair.local?.terminate();
      pair.remote.terminate();
      pair.socket.destroy();
    }
    this.pairs.clear();
    if (this.wss) await new Promise((resolve) => this.wss.close(resolve));
    if (this.http) await new Promise((resolve) => this.http.close(resolve));
  }
}
module.exports = { Relay, validateServer, CHUNK };
