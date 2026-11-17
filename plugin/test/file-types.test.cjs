"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { FILE_TYPES, fileTypeReport } = require("../src/native-file-types.cjs");
const { IOSController } = require("../src/ios-controller.cjs");
const { fingerprint } = require("../src/ios-account.cjs");

test("selective-sync diagnostics contain only category flags and an excluded-folder count", () => {
  const native = {
    filter: {
      allowTypes: new Set(["image", "pdf"]),
      ignoreFolders: ["SECRET-FOLDER"],
    },
  };
  assert.deepEqual(fileTypeReport(native), {
    available: true,
    types: {
      image: true,
      pdf: true,
      audio: false,
      video: false,
      unsupported: false,
    },
    excludedFolderCount: 1,
  });
  assert.equal(
    JSON.stringify(fileTypeReport(native)).includes("SECRET"),
    false,
  );
  const filter = {};
  Object.defineProperty(filter, "allowTypes", {
    get() {
      throw Error("Do not invoke getters");
    },
  });
  assert.deepEqual(fileTypeReport({ filter }), { available: false });
  const guarded = {};
  Object.defineProperty(guarded, "filter", {
    get() {
      throw Error("Do not invoke getters");
    },
  });
  assert.deepEqual(fileTypeReport(guarded), { available: false });
  assert.equal(
    FILE_TYPES.find((t) => t.id === "unsupported").description.includes("EPUB"),
    true,
  );
});

function fixture() {
  const calls = [],
    native = {
      vaultId: "owned-vault",
      host: "custom.example/sync",
      version: 123,
      filter: {
        allowTypes: new Set(["image", "pdf"]),
        ignoreFolders: ["Keep excluded"],
      },
      setSyncType(type, enabled) {
        calls.push([type, enabled]);
        if (enabled) this.filter.allowTypes.add(type);
        else this.filter.allowTypes.delete(type);
      },
      async saveData() {
        calls.push("saved");
      },
    };
  const controller = new IOSController(
    {},
    { vaultId: "owned-vault" },
    () => {
      throw Error("Must not make account requests");
    },
    () => {},
  );
  controller.native = native;
  controller.session = {
    authenticated: true,
    server: "https://custom.example",
  };
  return { controller, native, calls };
}

test("bridge file-type change delegates to the native setter and persists without resetting the vault/cursor or exclusions", async () => {
  const { controller, native, calls } = fixture(),
    expected = await fingerprint(native.setSyncType);
  await controller.setFileType("unsupported", true, expected);
  assert.deepEqual(calls, [["unsupported", true], "saved"]);
  assert.equal(controller.fileTypes().types.unsupported, true);
  assert.equal(native.version, 123);
  assert.equal(native.vaultId, "owned-vault");
  assert.deepEqual(native.filter.ignoreFolders, ["Keep excluded"]);
  await controller.setFileType("image", false, expected);
  assert.equal(controller.fileTypes().types.image, false);
});

test("file-type change rejects unknown keys, fingerprint mismatches, foreign vaults and operations cancelled before mutation", async () => {
  const { controller, native, calls } = fixture(),
    expected = await fingerprint(native.setSyncType);
  await assert.rejects(
    controller.setFileType("png", true, expected),
    /category/,
  );
  await assert.rejects(
    controller.setFileType("image", "yes", expected),
    /category/,
  );
  await assert.rejects(
    controller.setFileType("image", true, "wrong"),
    /Unqualified/,
  );
  native.host = "other.example/sync";
  await assert.rejects(
    controller.setFileType("image", true, expected),
    /match/,
  );
  native.host = "custom.example/sync";
  const pending = controller.setFileType("unsupported", true, expected);
  controller.generation++;
  await assert.rejects(pending, /cancelled/);
  controller.session.authenticated = false;
  await assert.rejects(
    controller.setFileType("image", true, expected),
    /Connect/,
  );
  assert.equal(calls.length, 0);
});
