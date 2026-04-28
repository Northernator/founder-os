/**
 * Ambient module declarations for third-party packages whose shipped
 * type definitions don't cover all entry points we use.
 *
 * Pt.34 cleanup: previously caused a TS7016 in `lib/chat-attachments.ts`
 * where the dynamic import of mammoth's browser entry failed type
 * resolution. Mammoth's main entry (`"mammoth"`) ships types, but the
 * subpath `"mammoth/mammoth.browser.js"` does not. The shim below
 * declares only the API surface we actually call (`extractRawText`),
 * which is enough for the typecheck and keeps us from over-coupling to
 * mammoth's full API.
 */

declare module "mammoth/mammoth.browser.js" {
  /**
   * Subset of mammoth's browser API used by `chat-attachments.extractDocx`.
   * If we ever call additional methods (convertToHtml, options, etc.),
   * add them here rather than reaching for `any`.
   */
  interface MammothBrowser {
    extractRawText(input: {
      arrayBuffer: ArrayBuffer;
    }): Promise<{ value: string; messages?: Array<{ message: string }> }>;
  }
  const mammoth: MammothBrowser;
  export default mammoth;
}
