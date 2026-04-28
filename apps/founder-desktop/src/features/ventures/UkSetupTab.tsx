/**
 * UkSetupTab (pt.33) — guided UI for the UK_SETUP_READY stage.
 *
 * Reads + writes `04_uk_business/uk-setup.json` (the canvas defined
 * in @founder-os/domain/uk-setup). Sections gate on entity type:
 * Ltd founders see incorporation fields; sole traders skip them.
 *
 * Pattern mirrors BrandTab (pt.24): debounced autosave, "Saved"
 * indicator, must-haves panel on the right driven by
 * `deriveUkSetupRules`. Less heavy than BrandTab because UK Setup
 * is mostly form fields and checkboxes — no LLM calls, no Rust-side
 * availability checks.
 *
 * Saving is best-effort: a failed write surfaces a toast but doesn't
 * block further edits. The canvas debounce (~600ms idle) covers most
 * typing patterns.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  EntityTypeSchema,
  UkSetupCanvasSchema,
  createEmptyUkSetupCanvas,
  deriveUkSetupRules,
  isUkSetupComplete,
  type EntityType,
  type UkSetupCanvas,
  type Venture,
  type VentureManifest,
} from "@founder-os/domain";
import { getUkSetupCanvasPath } from "@founder-os/workspace-core";
import { pushToast } from "../../lib/toasts.js";

const SAVE_DEBOUNCE_MS = 600;

type Props = {
  venture: Venture;
  manifest: VentureManifest | null;
};

export function UkSetupTab({ venture, manifest }: Props) {
  const canvasPath = useMemo(
    () => getUkSetupCanvasPath(venture.rootPath),
    [venture.rootPath]
  );

  const [canvas, setCanvas] = useState<UkSetupCanvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">(
    "saved"
  );

  // Debounce ref — cancelled on every edit, fires SAVE_DEBOUNCE_MS
  // after the last keystroke. Same pattern as BrandTab's autosave.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the autosave on the FIRST canvas state change (which is the
  // initial load from disk). Without this, every venture switch would
  // trigger a no-op write.
  const hydratedRef = useRef(false);

  // Load on mount / venture switch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      hydratedRef.current = false;
      try {
        const exists = await invoke<boolean>("path_exists", { path: canvasPath });
        if (exists) {
          const raw = await invoke<string>("read_file", { path: canvasPath });
          const parsed = UkSetupCanvasSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            if (!cancelled) setCanvas(parsed.data);
          } else {
            // File on disk is malformed — start with a fresh canvas
            // but don't overwrite. The pipeline step's same-day
            // tripwire will pick this up too.
            console.warn(
              "[uk-setup] canvas parse failed, using fresh defaults",
              parsed.error
            );
            if (!cancelled && manifest)
              setCanvas(createEmptyUkSetupCanvas(venture.id, manifest.entityType));
          }
        } else if (manifest) {
          // No canvas on disk yet — happens before the first pipeline
          // run. Initialise from the manifest so the user can edit
          // immediately; the autosave will create the file.
          if (!cancelled)
            setCanvas(createEmptyUkSetupCanvas(venture.id, manifest.entityType));
        }
      } catch (err) {
        console.error("[uk-setup] load failed", err);
        if (!cancelled && manifest)
          setCanvas(createEmptyUkSetupCanvas(venture.id, manifest.entityType));
      } finally {
        if (!cancelled) setLoading(false);
        // Hydration done — subsequent state changes are real edits.
        hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasPath, venture.id, manifest]);

  // Autosave on canvas change.
  useEffect(() => {
    if (!canvas || !hydratedRef.current) return;
    setSaveStatus("unsaved");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        const next = { ...canvas, updatedAt: new Date().toISOString() };
        await invoke("write_file", {
          path: canvasPath,
          content: JSON.stringify(next, null, 2) + "\n",
        });
        setSaveStatus("saved");
      } catch (err) {
        console.error("[uk-setup] save failed", err);
        pushToast({
          kind: "error",
          message: "Couldn't save UK Setup canvas",
          detail: err instanceof Error ? err.message : String(err),
        });
        setSaveStatus("unsaved");
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [canvas, canvasPath]);

  if (loading || !canvas || !manifest) {
    return (
      <div style={{ padding: 28, color: "#6B7280" }}>
        Loading UK Setup canvas…
      </div>
    );
  }

  const rules = deriveUkSetupRules(canvas, {
    hiresStaff: manifest.hiresStaff,
    handlesPersonalData: manifest.handlesPersonalData,
    takesPayments: manifest.takesPayments,
  });
  const passCount = rules.filter((r) => r.pass).length;

  // Local update helpers — each takes a partial patch and merges into
  // the relevant canvas section. Centralised so we don't duplicate
  // the spread pattern across every input.
  const update = <K extends keyof UkSetupCanvas>(key: K, value: UkSetupCanvas[K]) =>
    setCanvas((cur) => (cur ? { ...cur, [key]: value } : cur));
  const updateCompany = (patch: Partial<UkSetupCanvas["company"]>) =>
    setCanvas((cur) =>
      cur ? { ...cur, company: { ...cur.company, ...patch } } : cur
    );
  const updateAddress = (patch: Partial<UkSetupCanvas["company"]["registeredOffice"]>) =>
    setCanvas((cur) =>
      cur
        ? {
            ...cur,
            company: {
              ...cur.company,
              registeredOffice: { ...cur.company.registeredOffice, ...patch },
            },
          }
        : cur
    );
  const updateHmrc = (patch: Partial<UkSetupCanvas["hmrc"]>) =>
    setCanvas((cur) =>
      cur ? { ...cur, hmrc: { ...cur.hmrc, ...patch } } : cur
    );
  const updateBanking = (patch: Partial<UkSetupCanvas["banking"]>) =>
    setCanvas((cur) =>
      cur ? { ...cur, banking: { ...cur.banking, ...patch } } : cur
    );
  const updateInsurance = (patch: Partial<UkSetupCanvas["insurance"]>) =>
    setCanvas((cur) =>
      cur ? { ...cur, insurance: { ...cur.insurance, ...patch } } : cur
    );
  const updateIp = (patch: Partial<UkSetupCanvas["ipAssignment"]>) =>
    setCanvas((cur) =>
      cur
        ? { ...cur, ipAssignment: { ...cur.ipAssignment, ...patch } }
        : cur
    );

  /**
   * pt.39 — Companies House live name check.
   *
   * Mirrors the brand-tab trademark launcher pattern (pt.31b): opens the
   * public Companies House search page in the user's default browser
   * with the typed name pre-filled. Founder reviews the results and
   * comes back to flip status manually.
   *
   * Why a launcher rather than a Rust API handler:
   *   - The public search at find-and-update.company-information.service.gov.uk
   *     is free, no API key, no rate limit beyond the friendly browser
   *     usage. The proper API (api.company-information.service.gov.uk)
   *     requires a developer account + API key + auth headers, which is
   *     a separate phase.
   *   - Result interpretation needs human judgement anyway — names can
   *     match without conflicting (different SIC categories, dissolved
   *     companies don't always block, etc.). Sending the founder to the
   *     official UI gives them all the context they need.
   *   - Keeps the contract small: one Tauri `open_url` invoke, no
   *     network parsing, no API auth flow on Windows.
   *
   * Promote to a Rust handler in pt.40+ if friction warrants — the
   * shape is the same as the planned `companies_house.rs`, just inline
   * + interactive instead of headless + parsed.
   */
  const openCompaniesHouseSearch = async () => {
    const name = canvas?.company.name.trim() ?? "";
    if (!name) {
      pushToast({
        kind: "warn",
        message: "Enter a company name first",
        detail: "The Companies House search needs a query.",
      });
      return;
    }
    const url =
      "https://find-and-update.company-information.service.gov.uk/search/companies?q=" +
      encodeURIComponent(name);
    try {
      await invoke("open_url", { url });
      // pt.40d — Stamp `nameLastCheckedAt` on successful launch so the
      // UI can show a "Searched at HH:MM" hint. Mirrors the trademark
      // launcher's status-stamping pattern (pt.31b) — the founder
      // reviews the result in their browser and comes back to act on
      // it; the stamp tells them they've already looked. Only stamp
      // on success — if the launcher errored, the search didn't
      // actually happen.
      updateCompany({ nameLastCheckedAt: new Date().toISOString() });
    } catch (err) {
      pushToast({
        kind: "error",
        message: "Couldn't open Companies House",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isLtd = canvas.entityType === "ltd";

  return (
    <div style={{ padding: 28, display: "grid", gridTemplateColumns: "1fr 320px", gap: 24 }}>
      {/* ── Main column ─────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>
              UK Setup
            </h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6B7280" }}>
              Entity → registrations → banking → insurance → IP. Saved to{" "}
              <code>04_uk_business/uk-setup.json</code>.
            </p>
          </div>
          <SaveIndicator status={saveStatus} />
        </div>

        {/* 1. Entity type ──────────────────────────────────────── */}
        <Section title="1. Entity Type" icon="🏛️">
          <p style={{ margin: 0, fontSize: 12, color: "#6B7280" }}>
            How will you operate? Manifest set this to{" "}
            <strong>{manifest.entityType}</strong>; you can revise here.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(EntityTypeSchema.options as EntityType[]).map((opt) => {
              const active = canvas.entityType === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => update("entityType", opt)}
                  style={{
                    padding: "6px 14px",
                    fontSize: 12,
                    background: active ? "#6366F1" : "#FFFFFF",
                    color: active ? "#FFFFFF" : "#374151",
                    border: `1px solid ${active ? "#4338CA" : "#D1D5DB"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {opt.replace("_", " ")}
                </button>
              );
            })}
          </div>
        </Section>

        {/* 2. Company details — Ltd only ───────────────────────── */}
        {isLtd && (
          <Section title="2. Company Details" icon="🏢">
            <Field label="Companies House preferred name">
              <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
                <input
                  type="text"
                  value={canvas.company.name}
                  onChange={(e) => updateCompany({ name: e.target.value })}
                  placeholder="Acme Software Ltd"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={openCompaniesHouseSearch}
                  disabled={canvas.company.name.trim().length === 0}
                  title="Open the Companies House public search with this name"
                  style={{
                    padding: "0 14px",
                    border: "1px solid #D1D5DB",
                    borderRadius: 4,
                    background: canvas.company.name.trim().length === 0
                      ? "#F3F4F6"
                      : "#FFFFFF",
                    cursor: canvas.company.name.trim().length === 0
                      ? "not-allowed"
                      : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#374151",
                    whiteSpace: "nowrap",
                  }}
                >
                  Search Companies House
                </button>
              </div>
              {/* pt.40d — Render the last-searched timestamp so the
                  founder remembers they already checked. Just the local
                  HH:MM is enough; the date prefix only appears if the
                  check was on a different calendar day from "now",
                  which keeps the common case (same-session check) tidy. */}
              {canvas.company.nameLastCheckedAt && (
                <span
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: "#6B7280",
                  }}
                >
                  Searched Companies House {formatLastChecked(canvas.company.nameLastCheckedAt)}
                </span>
              )}
            </Field>
            <Field label="Company number (post-incorporation)">
              <input
                type="text"
                value={canvas.company.companyNumber}
                onChange={(e) => updateCompany({ companyNumber: e.target.value })}
                placeholder="12345678"
                style={inputStyle}
                maxLength={10}
              />
            </Field>
            <Field label="SIC code">
              <input
                type="text"
                value={canvas.company.sicCode}
                onChange={(e) => updateCompany({ sicCode: e.target.value })}
                placeholder="62012 — Business and domestic software development"
                style={inputStyle}
              />
            </Field>
            <Field label="Date of incorporation">
              <input
                type="date"
                value={canvas.company.incorporatedAt}
                onChange={(e) => updateCompany({ incorporatedAt: e.target.value })}
                style={inputStyle}
              />
            </Field>
            <fieldset style={fieldsetStyle}>
              <legend style={legendStyle}>Registered office</legend>
              <Field label="Address line 1">
                <input
                  type="text"
                  value={canvas.company.registeredOffice.line1}
                  onChange={(e) => updateAddress({ line1: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Address line 2">
                <input
                  type="text"
                  value={canvas.company.registeredOffice.line2}
                  onChange={(e) => updateAddress({ line2: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
                <Field label="City">
                  <input
                    type="text"
                    value={canvas.company.registeredOffice.city}
                    onChange={(e) => updateAddress({ city: e.target.value })}
                    style={inputStyle}
                  />
                </Field>
                <Field label="Postcode">
                  <input
                    type="text"
                    value={canvas.company.registeredOffice.postcode}
                    onChange={(e) =>
                      updateAddress({ postcode: e.target.value.toUpperCase() })
                    }
                    style={inputStyle}
                  />
                </Field>
              </div>
            </fieldset>
          </Section>
        )}

        {/* 3. HMRC ─────────────────────────────────────────────── */}
        <Section title={`${isLtd ? "3" : "2"}. HMRC & Tax`} icon="💰">
          <Field label="UTR (Unique Taxpayer Reference)">
            <input
              type="text"
              value={canvas.hmrc.utrNumber}
              onChange={(e) => updateHmrc({ utrNumber: e.target.value })}
              placeholder="1234567890"
              maxLength={10}
              style={inputStyle}
            />
          </Field>
          <Checkbox
            label="VAT registered"
            checked={canvas.hmrc.vatRegistered}
            onChange={(v) => updateHmrc({ vatRegistered: v })}
            hint={`UK threshold £85k. Below threshold → optional. ${manifest.takesPayments ? "Manifest says you take payments — may apply." : ""}`}
          />
          {canvas.hmrc.vatRegistered && (
            <Field label="VAT number">
              <input
                type="text"
                value={canvas.hmrc.vatNumber}
                onChange={(e) => updateHmrc({ vatNumber: e.target.value })}
                placeholder="GB123456789"
                style={inputStyle}
              />
            </Field>
          )}
          {manifest.hiresStaff && (
            <Checkbox
              label="PAYE registered (required when hiring)"
              checked={canvas.hmrc.payeRegistered}
              onChange={(v) => updateHmrc({ payeRegistered: v })}
            />
          )}
        </Section>

        {/* 4. Banking ───────────────────────────────────────────── */}
        <Section title={`${isLtd ? "4" : "3"}. Banking`} icon="🏦">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["not_started", "applied", "active"] as const).map((s) => {
              const active = canvas.banking.status === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => updateBanking({ status: s })}
                  style={{
                    padding: "5px 12px",
                    fontSize: 11,
                    background: active ? statusColours(s).bg : "#FFFFFF",
                    color: active ? statusColours(s).fg : "#6B7280",
                    border: `1px solid ${active ? statusColours(s).fg : "#E5E7EB"}`,
                    borderRadius: 4,
                    cursor: "pointer",
                    fontWeight: 600,
                    textTransform: "capitalize",
                  }}
                >
                  {s.replace("_", " ")}
                </button>
              );
            })}
          </div>
          <Field label="Bank">
            <input
              type="text"
              value={canvas.banking.bankName}
              onChange={(e) => updateBanking({ bankName: e.target.value })}
              placeholder="Mettle / Tide / Starling Business…"
              style={inputStyle}
            />
          </Field>
          <Field label="Account type">
            <input
              type="text"
              value={canvas.banking.accountType}
              onChange={(e) => updateBanking({ accountType: e.target.value })}
              placeholder="Business current"
              style={inputStyle}
            />
          </Field>
        </Section>

        {/* 5. Insurance ─────────────────────────────────────────── */}
        <Section title={`${isLtd ? "5" : "4"}. Insurance`} icon="🛡️">
          <Checkbox
            label="Professional indemnity"
            checked={canvas.insurance.professional}
            onChange={(v) => updateInsurance({ professional: v })}
            hint="Standard for software / consulting ventures"
          />
          <Checkbox
            label="Public liability"
            checked={canvas.insurance.publicLiability}
            onChange={(v) => updateInsurance({ publicLiability: v })}
            hint="Third-party injury / damage"
          />
          {(manifest.handlesPersonalData || manifest.takesPayments) && (
            <Checkbox
              label="Cyber insurance"
              checked={canvas.insurance.cyber}
              onChange={(v) => updateInsurance({ cyber: v })}
              hint="Recommended — manifest says you handle personal data or take payments"
            />
          )}
          {manifest.hiresStaff && (
            <Checkbox
              label="Employer's liability (legally required)"
              checked={canvas.insurance.employersLiability}
              onChange={(v) => updateInsurance({ employersLiability: v })}
            />
          )}
          <Field label="Notes (provider, policy number, renewal date)">
            <textarea
              value={canvas.insurance.notes}
              onChange={(e) => updateInsurance({ notes: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
        </Section>

        {/* 6. IP & founder agreements ───────────────────────────── */}
        <Section title={`${isLtd ? "6" : "5"}. IP & Agreements`} icon="📜">
          {isLtd && (
            <Checkbox
              label="Founder IP assigned to company"
              checked={canvas.ipAssignment.founderIpAssigned}
              onChange={(v) => updateIp({ founderIpAssigned: v })}
              hint="Critical — without this the company doesn't legally own its product"
            />
          )}
          <Checkbox
            label="Founder agreement signed (multi-founder ventures)"
            checked={canvas.ipAssignment.founderAgreementSigned}
            onChange={(v) => updateIp({ founderAgreementSigned: v })}
            hint="Vesting, decision-making, exit terms"
          />
          <Field label="Notes">
            <textarea
              value={canvas.ipAssignment.notes}
              onChange={(e) => updateIp({ notes: e.target.value })}
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
        </Section>
      </div>

      {/* ── Must-haves panel ──────────────────────────────────── */}
      <aside
        style={{
          padding: 16,
          background: "#F9FAFB",
          border: "1px solid #E5E7EB",
          borderRadius: 8,
          alignSelf: "start",
          position: "sticky",
          top: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
            Must-haves
          </h3>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: passCount === rules.length ? "#059669" : "#6B7280",
            }}
          >
            {passCount} / {rules.length}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map((rule) => (
            <div
              key={rule.id}
              style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
            >
              <span
                style={{
                  fontSize: 12,
                  marginTop: 1,
                  color: rule.pass ? "#059669" : "#9CA3AF",
                }}
              >
                {rule.pass ? "✅" : "○"}
              </span>
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: rule.pass ? "#111827" : "#374151",
                  }}
                >
                  {rule.label}
                </div>
                <div style={{ fontSize: 11, color: "#6B7280" }}>{rule.description}</div>
              </div>
            </div>
          ))}
        </div>
        {isUkSetupComplete(canvas, {
          hiresStaff: manifest.hiresStaff,
          handlesPersonalData: manifest.handlesPersonalData,
          takesPayments: manifest.takesPayments,
        }) && (
          <div
            style={{
              marginTop: 14,
              padding: 10,
              background: "#ECFDF5",
              border: "1px solid #A7F3D0",
              borderRadius: 6,
              fontSize: 12,
              color: "#065F46",
              fontWeight: 600,
            }}
          >
            ✓ All must-haves complete — ready to advance to Spec stage.
          </div>
        )}
      </aside>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 16,
        background: "#FFFFFF",
        border: "1px solid #E5E7EB",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#111827" }}>
        <span style={{ marginRight: 6 }}>{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#6B7280", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <div>
        <div style={{ fontSize: 13, color: "#111827", fontWeight: 500 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{hint}</div>
        )}
      </div>
    </label>
  );
}

function SaveIndicator({ status }: { status: "saved" | "saving" | "unsaved" }) {
  const cfg = {
    saved: { color: "#059669", text: "Saved" },
    saving: { color: "#6366F1", text: "Saving…" },
    unsaved: { color: "#D97706", text: "Unsaved" },
  }[status];
  return <span style={{ fontSize: 11, color: cfg.color, fontWeight: 600 }}>{cfg.text}</span>;
}

function statusColours(s: "not_started" | "applied" | "active"): {
  bg: string;
  fg: string;
} {
  switch (s) {
    case "not_started":
      return { bg: "#F3F4F6", fg: "#6B7280" };
    case "applied":
      return { bg: "#FEF3C7", fg: "#92400E" };
    case "active":
      return { bg: "#ECFDF5", fg: "#065F46" };
  }
}

/**
 * pt.40d — Format an ISO timestamp for the "Searched Companies House X"
 * hint. Same-day checks render as bare time ("at 14:32"); cross-day
 * checks include the date ("on 26 Apr at 14:32") so a returning
 * founder isn't misled. Bad ISO strings render as the raw value rather
 * than throwing — the hint is decorative, not load-bearing.
 */
function formatLastChecked(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `(${iso})`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `at ${hh}:${mm}`;
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `on ${day} at ${hh}:${mm}`;
}

const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid #D1D5DB",
  background: "#FFFFFF",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #E5E7EB",
  borderRadius: 6,
  padding: "10px 12px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  margin: 0,
};

const legendStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#6B7280",
  padding: "0 6px",
};
