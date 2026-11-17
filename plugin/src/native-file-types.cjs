"use strict";

// Category names are the native settings keys, not file extensions.
const FILE_TYPES = Object.freeze([
  {
    id: "image",
    name: "Sync images",
    description: "PNG, JPG, SVG, WebP and other native image formats.",
  },
  { id: "pdf", name: "Sync PDFs", description: "PDF attachments." },
  { id: "audio", name: "Sync audio", description: "Native audio formats." },
  { id: "video", name: "Sync videos", description: "Native video formats." },
  {
    id: "unsupported",
    name: "Sync all other types",
    description:
      "ZIP, EPUB, HEIC and other files outside the native media categories.",
  },
]);

function data(object, name) {
  const descriptor = object && Object.getOwnPropertyDescriptor(object, name);
  return descriptor && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function fileTypeReport(native) {
  const filter = data(native, "filter"),
    allowed = data(filter, "allowTypes");
  const types = {};
  try {
    for (const { id } of FILE_TYPES)
      types[id] = Set.prototype.has.call(allowed, id);
  } catch {
    return { available: false };
  }
  const excluded = data(filter, "ignoreFolders");
  return {
    available: true,
    types,
    excludedFolderCount: Array.isArray(excluded) ? excluded.length : null,
    // Deliberately omit paths, names, retry messages and file contents.
  };
}

module.exports = { FILE_TYPES, fileTypeReport };
