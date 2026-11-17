"use strict";
// The normal plugin loader runs the renderer branch. The renderer loads the
// same installed asset through @electron/remote for session-wide routing.
if (typeof process !== "undefined" && process.type === "browser") {
  module.exports = require("./main-coordinator.cjs");
} else {
  const { Platform } = require("obsidian");
  const { compatibility } = require("./compatibility.cjs");
  // Mobile must never evaluate the desktop module or its Node dependencies.
  module.exports =
    compatibility(Platform).adapter === "desktop"
      ? require("./main.cjs")
      : require("./mobile-diagnostics.cjs");
}
