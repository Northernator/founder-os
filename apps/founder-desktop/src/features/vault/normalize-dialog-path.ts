/**
 * Normalise a path returned by `@tauri-apps/plugin-dialog`'s `open()`.
 *
 * The plugin's return value SHOULD be a plain OS-native absolute path,
 * but in practice we've seen two shapes leak through depending on
 * platform + plugin version:
 *
 *   1. `file:///C:/Users/taylo/Downloads/chat.json`
 *      The `file://` URI form. Hands straight to Rust's `Path::new`
 *      and Rust tries to open a file literally named "file:" inside
 *      a "//C:" directory -- fails with `os error 3` "path not found".
 *
 *   2. `C:\Users\taylo\Downloads\My%20chat.json`
 *      URL-encoded spaces / specials. Rust opens the LITERAL filename
 *      "My%20chat.json" instead of "My chat.json" -- same `os error 3`.
 *
 * Both shapes triggered the silent stub-hash fallback in the runner
 * before the `safeInvoke` predicate got tightened (see
 * `run-vault-import.ts:isCommandNotRegisteredError`). With that fix
 * the underlying "source file not found: <bad path>" surfaces, but
 * the right fix is to never produce the bad path in the first place
 * -- which is what this helper does at the dialog call site.
 *
 * Safe for both Windows and POSIX paths. Idempotent: calling twice
 * is the same as calling once.
 *
 * Lives renderer-side rather than in `@founder-os/local-file-importer`
 * because the dialog interaction itself is renderer-side -- the
 * package's surface is the orchestration layer that runs after a
 * caller has already produced clean absolute paths.
 */

/** Match `file://` (any number of trailing slashes). */
const FILE_URI_PREFIX_REGEX = /^file:\/\/+/i;

export function normalizeDialogPath(input: string): string {
  if (!input) return input;
  let path = input;

  // 1. Strip `file://` / `file:///`. After stripping `file:///`, a
  //    Windows path looks like `C:/Users/...` (valid) -- POSIX
  //    paths in the URI form are rare in practice but the strip
  //    yields a usable absolute path either way.
  if (FILE_URI_PREFIX_REGEX.test(path)) {
    path = path.replace(FILE_URI_PREFIX_REGEX, "");
  }

  // 2. URL-decode. `decodeURIComponent` throws on malformed percent
  //    escapes; defensively wrap so a non-encoded path that happens
  //    to contain a stray `%` doesn't fall into the error branch.
  if (path.includes("%")) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Leave as-is; a legitimate "source file not found" from Rust
      // (now visible thanks to the tightened safeInvoke predicate)
      // will point at the un-decoded path so the user can see it.
    }
  }

  return path;
}
