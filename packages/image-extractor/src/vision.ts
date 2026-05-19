/**
 * Vision summary -- gated behind an injected callLlm. Per
 * DREAM-VAULT-MODULE-SPEC §1.2: NEVER import a provider SDK directly.
 * The desktop wires up streamChat / cli-client (subscription-first) and
 * hands us a callLlm-shaped function. If the caller passes nothing, we
 * skip vision and the orchestrator marks the result needs_review.
 */

export interface VisionCallLlmInput {
  /** Plain-text instruction. */
  prompt: string;
  /**
   * Image data. The desktop's callLlm wraps multimodal input; we keep
   * the shape simple here so tests can stub it without dragging in the
   * full chat message schema.
   */
  imageBuffer: Uint8Array;
  imageMimeType: string;
}

export type VisionCallLlm = (input: VisionCallLlmInput) => Promise<string>;

export interface VisionResult {
  summary: string;
  warnings: string[];
  confidence: "high" | "medium" | "low";
}

const DEFAULT_PROMPT = [
  "You are summarising an image for a startup founder's vault.",
  "Describe what is in the image in <= 4 sentences.",
  "If it looks like a screenshot or a UI mock, note that explicitly.",
].join(" ");

export async function summariseImageWithLlm(input: {
  buffer: Uint8Array;
  mimeType: string;
  callLlm: VisionCallLlm;
  prompt?: string;
}): Promise<VisionResult> {
  const warnings: string[] = [];
  try {
    const summary = await input.callLlm({
      prompt: input.prompt ?? DEFAULT_PROMPT,
      imageBuffer: input.buffer,
      imageMimeType: input.mimeType,
    });
    const trimmed = summary.trim();
    if (!trimmed) {
      warnings.push("vision model returned empty text");
      return { summary: "", warnings, confidence: "low" };
    }
    return { summary: trimmed, warnings, confidence: "medium" };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warnings.push(`vision model call failed: ${message}`);
    return { summary: "", warnings, confidence: "low" };
  }
}
