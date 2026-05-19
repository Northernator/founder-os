/**
 * @founder-os/local-file-importer/node -- Node-only entry point.
 *
 * The renderer cannot import this subpath (biome rule -- see
 * apps/founder-desktop/biome.json). Use the root barrel for types and
 * call these from a Tauri sidecar or CLI.
 */

export { walkFolder } from "./node/walk-folder.js";
export { resolveFile } from "./node/resolve-file.js";
