#!/usr/bin/env tsx
/**
 * @founder-os/document-extractor Node sidecar CLI -- slice 3 of the
 * Rust IPC arc.
 *
 * The Tauri WebView can't import `mammoth` directly because the
 * renderer is browser-class and `mammoth` requires `node:fs` +
 * `node:buffer`. Following the same precedent as
 * @founder-os/backend-providers / @founder-os/crm-providers: the Tauri
 * host spawns this one-shot Node process via
 * `pnpm --filter @founder-os/document-extractor cli -- extract-docx --abs <path>`,
 * we do the mammoth call, and emit a single-line JSON envelope on
 * stdout that the Rust command parses.
 *
 * Subcommands:
 *   document-extractor extract-docx --abs <path>
 *
 * Output contract: every successful run writes ONE line to stdout, a JSON
 * object matching ExtractDocxResult below. Diagnostic chatter goes to
 * stderr. Errors emit `{"error": "..."}` on stdout AND exit non-zero
 * so the Rust side has a structured failure path even when something
 * has gone sideways.
 *
 * PDF extraction is NOT routed through this CLI -- the Rust crate
 * `pdf-extract` handles PDFs in-process via `vault_extract_pdf` in
 * vault_extract.rs. Keeping PDF + DOCX in separate transports is a
 * deliberate cost trade: PDF can stay pure-Rust + sub-100ms; DOCX is
 * mammoth-only and Node-only, so it eats the ~200ms pnpm-spawn tax.
 */

import { readFile } from "node:fs/promises";

import { createMammothTextExtractor } from "./node/mammoth-extractor.js";

type ExtractDocxResult =
  | { markdown: string; warnings: string[] }
  | { error: string };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (!subcommand) {
    printUsage();
    process.exit(2);
  }
  try {
    switch (subcommand) {
      case "extract-docx": {
        const out = await extractDocx(argv.slice(1));
        emit(out);
        process.exit(0);
      }
      default:
        emit({ error: `unknown subcommand: ${subcommand}` });
        printUsage();
        process.exit(2);
    }
  } catch (err) {
    emit({ error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

function emit(payload: ExtractDocxResult): void {
  // Single line so the Rust side parses with a `lines().next()` style read.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printUsage(): void {
  process.stderr.write(
    [
      "usage: document-extractor <subcommand> [flags]",
      "",
      "subcommands:",
      "  extract-docx --abs <path>",
      "",
    ].join("\n"),
  );
}

async function extractDocx(args: string[]): Promise<ExtractDocxResult> {
  const abs = required(flag(args, "--abs"), "--abs");
  // readFile returns a Node Buffer which is a Uint8Array subclass; the
  // DocxTextExtractor.extractText signature takes Uint8Array, so the
  // pass-through is exact (no ArrayBuffer slicing needed).
  const bytes = await readFile(abs);
  const extractor = createMammothTextExtractor();
  const result = await extractor.extractText(bytes);
  return { markdown: result.text, warnings: result.warnings };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required flag: ${name}`);
  }
  return value;
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
});
