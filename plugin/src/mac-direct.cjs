"use strict";

// Obsidian desktop 1.15.1. Account discovery and the direct connector share
// the iPhone implementation, with fingerprints from the verified Mac bundle.
const MAC_1151 = Object.freeze({
  asyncGetServer: "77b3ee920dffc38fcca8fdc8908479badb0b5061b230bf2a8862d1b417f4dfca",
  accountClass: "777ccb2a84c15bcf42a4d666eea1ac7390766a83396a840260f848589e4d5bb3",
  setup: "4053ee30c5f677a6e7a4c139af106c8303ccf17b87d9ad27c384247b3f47dc37",
  setSyncType: "c6adce9f9645e0bfff5f99c53a70d5385e98b21e9cb8796830427651e607569d",
  transportClass: "0c90299aa39847ae7ba4d82236134216ebcce87aa29ceb47d4d48cc869f36f6b",
});

async function macDirectRequest({ url, method, headers, body }) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, json: await response.json() };
}

module.exports = { MAC_1151, macDirectRequest };
