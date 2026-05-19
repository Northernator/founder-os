/**
 * @founder-os/local-file-importer public entry -- CLIENT-SAFE.
 *
 * Slice 2 of the DREAM_VAULT_MODULE arc. The renderer drives the Tauri
 * `dialog` plugin to collect file/folder paths, then hands the resolved
 * paths to `ingestFiles` / `ingestFolder` along with the Node-side ports
 * (resolveFile, walkFolder, hashFile, stageOriginal).
 *
 * The Node bindings live in "./node" and are imported only from the
 * Node-side wiring (the Tauri sidecar, the CLI, or tests).
 */

export {
  type IngestFilesInput,
  type IngestFolderInput,
  type LocalImporterDeps,
  type LocalImporterResult,
  ingestFiles,
  ingestFolder,
} from "./ingest";

export {
  type DiscoveredFile,
  type ResolveAbsoluteFileFn,
  type WalkFolderFn,
  shouldIngest,
} from "./walk";
