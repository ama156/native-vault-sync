"use strict";
// The normal plugin loader runs the renderer branch. The renderer loads the
// same installed asset through @electron/remote for session-wide routing.
module.exports =
  process.type === "browser"
    ? require("./main-coordinator.cjs")
    : require("./main.cjs");
