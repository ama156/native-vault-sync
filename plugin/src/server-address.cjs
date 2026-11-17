"use strict";
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
module.exports = { validateServer };
