/**
 * @founder-os/chat-importer/node -- reserved for future Node-only code
 * (e.g. streaming JSON parsers for multi-GB exports). For slice 4 the
 * parsers are pure-TS and reachable from the client-safe barrel; this
 * subpath simply re-exports the barrel so future additions don't break
 * importers that already chose `/node`.
 */

export * from "./index.js";
