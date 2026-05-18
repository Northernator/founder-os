/**
 * CodesignPreviewModal -- in-app fallback for the CoDesign launcher.
 *
 * Slice 4 of the CoDesign-launcher arc. When chainCodesignLaunch (in
 * ScreensTab) finds Open CoDesign isn't installed, it opens this modal
 * with the HandoffExport we just wrote. The modal:
 *
 *   1. Renders export.html in a sandboxed iframe (left column).
 *   2. Builds a sidebar of inputs from export.parameters -- color
 *      pickers for type=color, range sliders for type=number, native
 *      selects for type=select.
 *   3. On every input change, injects a `<style>:root { --foo: bar; }</style>`
 *      block into the iframe's srcDoc so the prototype updates live.
 *   4. "Save tweaks" writes the updated HandoffExport back to disk via
 *      the same Tauri `write_file` command ScreensTab uses for the
 *      Screens canvas. BUILD picks up the new parameter values on its
 *      next run.
 *
 * Why a modal and not a separate Tauri WebviewWindow: simpler IPC
 * surface, no extra Rust commands, no second-window lifecycle to
 * manage. The export's HTML is sandboxed inside an iframe with
 * sandbox="allow-same-origin" only -- no JS execution, no top-frame
 * navigation. If the founder later wants a detached window, this same
 * component can mount into one via window.open() + portal.
 *
 * The modal is owned by ScreensTab; it controls open/close via prop.
 * onSave fires AFTER the disk write succeeds so the caller can refresh
 * downstream state (failed-run banners, BUILD stage, etc).
 */

import { type HandoffExport, type SliderParam } from "@founder-os/handoff-contract";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { pushToast } from "../../lib/toasts.js";

export function CodesignPreviewModal({
  exportArtifact,
  exportPath,
  onClose,
  onSave,
}: {
  /** The HandoffExport we just wrote. parameters + html drive the UI. */
  exportArtifact: HandoffExport;
  /** Absolute path to handoff-export.json -- where Save writes back. */
  exportPath: string;
  /** Called when the user clicks Close / hits Esc / clicks the backdrop. */
  onClose: () => void;
  /**
   * Called AFTER a successful disk write so the parent can refresh
   * downstream state. Receives the updated artifact.
   */
  onSave?: (updated: HandoffExport) => void;
}) {
  // Local mutable copy of parameters -- we don't touch the prop.
  const [sliders, setSliders] = useState<Record<string, SliderParam>>(
    () => ({ ...(exportArtifact.parameters ?? {}) }),
  );
  const [saving, setSaving] = useState(false);

  // Compute the live preview HTML by injecting an override stylesheet
  // into the export's HTML. The injection runs late so it wins over
  // the original :root block.
  const previewHtml = useMemo(
    () => injectLiveStyles(exportArtifact.html, sliders),
    [exportArtifact.html, sliders],
  );

  const handleSliderChange = (key: string, nextValue: number | string) => {
    setSliders((prev) => {
      const current = prev[key];
      if (!current) return prev;
      return { ...prev, [key]: { ...current, value: nextValue } };
    });
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const updated: HandoffExport = {
        ...exportArtifact,
        parameters: sliders,
        notes:
          (exportArtifact.notes ? `${exportArtifact.notes}\n` : "") +
          `[preview-modal] tweaks applied at ${new Date().toISOString()}`,
      };
      await invoke("write_file", {
        path: exportPath,
        content: `${JSON.stringify(updated, null, 2)}\n`,
      });
      pushToast({
        kind: "success",
        message: "CoDesign export updated",
        detail: `${Object.keys(sliders).length} slider value(s) saved to handoff-export.json. BUILD will pick them up on the next run.`,
        ttlMs: 6000,
      });
      onSave?.(updated);
      onClose();
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't save tweaks",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const sliderEntries = Object.entries(sliders);

  // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is decorative; Close button + Esc handle a11y
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(1400px, 100%)",
          height: "min(900px, 100%)",
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
          display: "grid",
          gridTemplateColumns: "1fr 320px",
          gridTemplateRows: "auto 1fr auto",
          overflow: "hidden",
        }}
      >
        {/* Header (spans both columns) */}
        <header
          style={{
            gridColumn: "1 / span 2",
            padding: "14px 18px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              CoDesign preview (in-app fallback)
            </h2>
            <p
              style={{
                margin: "2px 0 0 0",
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              Open CoDesign isn't installed -- tweak the parametric sliders here and save back to
              handoff-export.json. BUILD reads the updated values on its next run.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "6px 12px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-primary)",
              borderRadius: 6,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </header>

        {/* Iframe preview (left column, middle row) */}
        <main
          style={{
            background: "#fff",
            borderRight: "1px solid var(--border-subtle)",
            overflow: "hidden",
          }}
        >
          <iframe
            title="CoDesign preview"
            srcDoc={previewHtml}
            sandbox="allow-same-origin"
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </main>

        {/* Sidebar of slider inputs (right column, middle row) */}
        <aside
          style={{
            padding: 16,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Parametric sliders</h3>
            <p style={{ margin: "2px 0 0 0", fontSize: 11, color: "var(--text-muted)" }}>
              {sliderEntries.length} knob{sliderEntries.length === 1 ? "" : "s"} from the stub
              export.
            </p>
          </div>
          {sliderEntries.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
              No sliders in this export. Save will be a no-op.
            </p>
          )}
          {sliderEntries.map(([key, slider]) => (
            <SliderInput
              key={key}
              keyName={key}
              slider={slider}
              onChange={(next) => handleSliderChange(key, next)}
            />
          ))}
        </aside>

        {/* Footer (spans both columns) */}
        <footer
          style={{
            gridColumn: "1 / span 2",
            padding: "12px 18px",
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-primary)",
              borderRadius: 6,
              fontSize: 13,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || sliderEntries.length === 0}
            style={{
              padding: "8px 16px",
              background: saving ? "var(--bg-elevated)" : "var(--accent-soft)",
              border: `1px solid ${saving ? "var(--border-subtle)" : "var(--accent-soft)"}`,
              color: saving ? "var(--text-muted)" : "var(--accent-hover)",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: saving || sliderEntries.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving..." : "Save tweaks"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the iframe srcDoc by injecting a late `:root` block that
 * overrides the export's CSS variables with current slider values.
 *
 * If export.html is missing we render a placeholder so the modal still
 * makes sense (sidebar inputs work, save still updates parameters).
 */
function injectLiveStyles(
  html: string | undefined,
  sliders: Record<string, SliderParam>,
): string {
  const base =
    html?.trim() ||
    "<!doctype html><html><body style=\"font-family: system-ui; padding: 40px; color: #555;\"><p>No HTML scaffold in this export. Tweak the sliders to update parameters anyway.</p></body></html>";

  const cssRules = Object.values(sliders)
    .filter((p): p is SliderParam & { cssVar: string } => Boolean(p.cssVar))
    .map((p) => `${p.cssVar}: ${formatCssValue(p)};`)
    .join(" ");
  if (!cssRules) return base;

  const overrideStyle = `<style data-codesign-override>:root { ${cssRules} }</style>`;
  // Inject right before </head>, or right after <body> if no </head>.
  if (base.includes("</head>")) {
    return base.replace("</head>", `${overrideStyle}</head>`);
  }
  if (base.includes("<body")) {
    return base.replace(/<body([^>]*)>/, `<body$1>${overrideStyle}`);
  }
  return overrideStyle + base;
}

/**
 * Format a SliderParam value for CSS. Number params whose cssVar
 * suggests a length (space-*, radius-*, size-*) get a `px` suffix.
 * Everything else (colors, font weights, raw scalars) goes through
 * verbatim.
 */
function formatCssValue(p: SliderParam): string {
  if (p.type === "number" && typeof p.value === "number") {
    const v = p.cssVar ?? "";
    if (/space|radius|size/i.test(v)) return `${p.value}px`;
    return String(p.value);
  }
  return String(p.value);
}

function SliderInput({
  keyName,
  slider,
  onChange,
}: {
  keyName: string;
  slider: SliderParam;
  onChange: (next: number | string) => void;
}) {
  const labelText = slider.label || keyName;
  if (slider.type === "color") {
    return (
      <label
        style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
        title={slider.description}
      >
        <span style={{ fontWeight: 600 }}>{labelText}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="color"
            value={String(slider.value)}
            onChange={(e) => onChange(e.target.value)}
            style={{
              width: 36,
              height: 36,
              padding: 0,
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              background: "transparent",
              cursor: "pointer",
            }}
          />
          <code
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {String(slider.value)}
          </code>
        </div>
        {slider.cssVar && (
          <code style={{ fontSize: 10, color: "var(--text-muted)" }}>{slider.cssVar}</code>
        )}
      </label>
    );
  }
  if (slider.type === "select" && slider.options && slider.options.length > 0) {
    return (
      <label
        style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
        title={slider.description}
      >
        <span style={{ fontWeight: 600 }}>{labelText}</span>
        <select
          value={String(slider.value)}
          onChange={(e) => onChange(e.target.value)}
          style={{
            padding: "6px 8px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            color: "var(--text-primary)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {slider.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {slider.cssVar && (
          <code style={{ fontSize: 10, color: "var(--text-muted)" }}>{slider.cssVar}</code>
        )}
      </label>
    );
  }
  // number (default)
  const min = slider.min ?? 0;
  const max = slider.max ?? 100;
  const step = slider.step ?? 1;
  const value = typeof slider.value === "number" ? slider.value : Number(slider.value) || min;
  return (
    <label
      style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}
      title={slider.description}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>{labelText}</span>
        <code
          style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}
        >
          {value}
        </code>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      {slider.cssVar && (
        <code style={{ fontSize: 10, color: "var(--text-muted)" }}>{slider.cssVar}</code>
      )}
    </label>
  );
}
