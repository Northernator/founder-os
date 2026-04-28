import React, { useState } from "react";
import type {
  Venture,
  VentureStage,
  VentureManifest,
  EntityType,
  AppType,
} from "@founder-os/domain";
import { pickVentureFolder, joinPath } from "../../lib/venture-io.js";

const ENTITY_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "undecided", label: "Undecided" },
  { value: "sole_trader", label: "Sole Trader" },
  { value: "ltd", label: "Limited Company" },
  { value: "partnership", label: "Partnership" },
];

const APP_OPTIONS: { value: AppType; label: string }[] = [
  { value: "saas", label: "SaaS" },
  { value: "web", label: "Web app" },
  { value: "desktop", label: "Desktop app" },
  { value: "mobile", label: "Mobile app" },
  { value: "browser_extension", label: "Browser extension" },
  { value: "game", label: "Game" },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `vnt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type CreateVentureInput = {
  venture: Venture;
  manifest: VentureManifest;
};

export function NewVentureWizard({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreateVentureInput) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<EntityType>("undecided");
  const [appType, setAppType] = useState<AppType>("saas");
  const [parentFolder, setParentFolder] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugify(name);
  const resolvedRoot =
    parentFolder && slug ? joinPath(parentFolder, slug) : null;

  const canSubmit =
    name.trim().length >= 2 && slug.length > 0 && !!parentFolder && !submitting;

  const handlePickFolder = async () => {
    setError(null);
    try {
      const picked = await pickVentureFolder();
      if (picked) setParentFolder(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !parentFolder || !resolvedRoot) return;
    setSubmitting(true);
    setError(null);

    const now = new Date().toISOString();
    const venture: Venture = {
      id: makeId(),
      name: name.trim(),
      slug,
      stage: "IDEA" as VentureStage,
      rootPath: resolvedRoot,
      createdAt: now,
      updatedAt: now,
    };

    const manifest: VentureManifest = {
      id: venture.id,
      name: venture.name,
      slug: venture.slug,
      entityType,
      appType,
      regulated: false,
      takesPayments: false,
      handlesPersonalData: false,
      hiresStaff: false,
      currentStage: venture.stage,
      blockers: [],
    };

    try {
      await onCreate({ venture, manifest });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-venture-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        style={{
          background: "#FFFFFF",
          borderRadius: 12,
          padding: 28,
          width: "min(480px, calc(100vw - 32px))",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div>
          <h2
            id="new-venture-title"
            style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" }}
          >
            New Venture
          </h2>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#6B7280" }}>
            We'll create a folder with the full stage skeleton and save a{" "}
            <code>venture.yaml</code> manifest at its root.
          </p>
        </div>

        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lumen Analytics"
            style={inputStyle}
          />
          {name.trim().length >= 2 && (
            <span style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>
              slug: <code>{slug}</code>
            </span>
          )}
        </Field>

        <Field label="App type">
          <select
            value={appType}
            onChange={(e) => setAppType(e.target.value as AppType)}
            style={inputStyle}
          >
            {APP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>

        <Field label="UK entity type">
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as EntityType)}
            style={inputStyle}
          >
            {ENTITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Workspace folder">
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <div
              style={{
                ...inputStyle,
                flex: 1,
                display: "flex",
                alignItems: "center",
                color: parentFolder ? "#111827" : "#9CA3AF",
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                cursor: "default",
              }}
              title={parentFolder ?? ""}
            >
              {parentFolder ?? "No folder chosen"}
            </div>
            <button
              type="button"
              onClick={handlePickFolder}
              style={secondaryBtnStyle}
            >
              Choose…
            </button>
          </div>
          {resolvedRoot && (
            <span style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>
              will create: <code>{resolvedRoot}</code>
            </span>
          )}
        </Field>

        {error && (
          <div
            style={{
              background: "#FEF2F2",
              color: "#991B1B",
              border: "1px solid #FECACA",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 6,
          }}
        >
          <button type="button" onClick={onClose} style={cancelBtnStyle}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            style={submitBtnStyle(!canSubmit)}
          >
            {submitting ? "Creating…" : "Create venture"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  fontSize: 14,
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid #D1D5DB",
  background: "#FFFFFF",
  outline: "none",
  fontFamily: "inherit",
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "#FFFFFF",
  color: "#374151",
  border: "1px solid #D1D5DB",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "0 14px",
  background: "#F3F4F6",
  color: "#111827",
  border: "1px solid #D1D5DB",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const submitBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: "8px 14px",
  background: disabled ? "#A5B4FC" : "#6366F1",
  color: "#FFFFFF",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  cursor: disabled ? "not-allowed" : "pointer",
});
