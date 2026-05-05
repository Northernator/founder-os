import { Button, Card } from "@founder-os/ui";
/**
 * Subscriptions section — subscription-mode providers via vendor CLIs.
 *
 * Rendered at the top of the Options tab, above the API-key rows. Three
 * cards (Claude / ChatGPT / Gemini) each show the install and sign-in
 * state of the vendor's CLI on this machine. Click "Sign in" and we
 * spawn `<cli> login` which drives its own browser OAuth flow — no
 * API key is involved and usage counts against the user's consumer
 * subscription (Claude Pro, ChatGPT Plus, Gemini Advanced) rather than
 * API billing.
 *
 * Persistence: signing in flips the corresponding `llm_settings` row
 * into `mode: 'subscription'` with `enabled: true` and points the
 * active-provider at it (Claude becomes the default on first sign-in
 * per product requirement — Claude main, others ready). Signing out
 * flips back to `api_key` and disables — we don't touch the vendor's
 * credentials file, that's the CLI's business.
 */
import { useEffect, useRef, useState } from "react";
import {
  CLI_AGENT_IDS,
  CLI_AGENT_META,
  type CliAgentId,
  type CliStatus,
  cliCheckInstalled,
  cliLogin,
} from "../../lib/cli-client.js";
import * as db from "../../lib/db.js";

type CardState = {
  loading: boolean;
  status: CliStatus | null;
  /** Live output from the current `cli login` subprocess. */
  loginLog: { line: string; stream: "stdout" | "stderr" }[];
  loginRunning: boolean;
  loginError: string | null;
  /** Mirror of the DB row so we can tell "signed in AND wired into
   *  Founder OS" from "signed in but never flipped to subscription". */
  saved: db.LlmSetting | null;
};

function emptyCardState(): CardState {
  return {
    loading: true,
    status: null,
    loginLog: [],
    loginRunning: false,
    loginError: null,
    saved: null,
  };
}

type Props = {
  /** Bumped after a sign-in/sign-out so the parent OptionsTab can re-hydrate
   *  the API-key rows and the Active-provider dropdown. */
  onChanged?: () => void;
};

export function SubscriptionsSection({ onChanged }: Props) {
  const [cards, setCards] = useState<Record<CliAgentId, CardState>>(
    () =>
      Object.fromEntries(CLI_AGENT_IDS.map((id) => [id, emptyCardState()])) as Record<
        CliAgentId,
        CardState
      >
  );
  // In-flight login abort controllers, keyed by agent. Kept in a ref so
  // the button render doesn't re-create them when cards state changes.
  const loginCtrls = useRef<Record<CliAgentId, AbortController | null>>({
    anthropic: null,
    openai: null,
    gemini: null,
  });

  useEffect(() => {
    void refreshAll();
    // The effect runs once on mount. Re-checks fire manually after
    // sign-in / sign-out finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAll() {
    await Promise.all(CLI_AGENT_IDS.map(refreshOne));
  }

  async function refreshOne(agent: CliAgentId) {
    setCards((prev) => ({
      ...prev,
      [agent]: { ...prev[agent], loading: true },
    }));
    try {
      const [status, saved] = await Promise.all([
        cliCheckInstalled(agent),
        db.getLlmSetting(agent),
      ]);
      setCards((prev) => ({
        ...prev,
        [agent]: {
          ...prev[agent],
          loading: false,
          status,
          saved,
        },
      }));
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [agent]: {
          ...prev[agent],
          loading: false,
          loginError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  /**
   * Persist the provider row as subscription-mode. Shared by the
   * "Connect" path (CLI already authenticated — no subprocess needed)
   * and the "Sign in" path (after a successful login subprocess).
   * Also seeds the Active-provider pointer per the "Claude as main"
   * rule: Claude wins if available, otherwise whoever just connected.
   */
  async function persistSubscription(agent: CliAgentId) {
    await db.upsertLlmSetting({
      provider: agent,
      mode: "subscription",
      enabled: true,
    });
    const currentActive = await db.getAppSetting(db.ACTIVE_PROVIDER_KEY);
    const claudeSetting = await db.getLlmSetting("anthropic");
    const claudeReady = claudeSetting?.enabled === true && claudeSetting.mode === "subscription";
    if (!currentActive || currentActive === "") {
      await db.setAppSetting(db.ACTIVE_PROVIDER_KEY, claudeReady ? "anthropic" : agent);
    } else if (agent === "anthropic" && currentActive !== "anthropic") {
      await db.setAppSetting(db.ACTIVE_PROVIDER_KEY, "anthropic");
    }
    await refreshOne(agent);
    onChanged?.();
  }

  /**
   * "Connect" — the CLI is installed and already signed in (vendor
   * installer auto-authed, or user ran `<cli> login` in a terminal).
   * No subprocess needed; just persist the mode flip.
   *
   * This exists as its own path because Claude Code 2.1.x — the common
   * case — doesn't have a `claude login` command-line subcommand. It
   * auto-authenticates on first `claude` invocation against the user's
   * Claude Pro subscription, so the credentials file already exists by
   * the time the user clicks this button. Spawning `claude login`
   * would just feed "login" to the model as a prompt.
   */
  async function handleConnect(agent: CliAgentId) {
    setCards((prev) => ({
      ...prev,
      [agent]: { ...prev[agent], loginError: null },
    }));
    try {
      await persistSubscription(agent);
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [agent]: {
          ...prev[agent],
          loginError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  async function handleSignIn(agent: CliAgentId) {
    const controller = new AbortController();
    loginCtrls.current[agent] = controller;
    setCards((prev) => ({
      ...prev,
      [agent]: {
        ...prev[agent],
        loginRunning: true,
        loginLog: [],
        loginError: null,
      },
    }));
    try {
      const success = await cliLogin(agent, {
        onOutput: (line, stream) => {
          setCards((prev) => ({
            ...prev,
            [agent]: {
              ...prev[agent],
              // Cap retained lines so a verbose vendor doesn't bloat
              // React state indefinitely. First 200 lines is more than
              // any login flow writes.
              loginLog: [...prev[agent].loginLog, { line, stream }].slice(-200),
            },
          }));
        },
        signal: controller.signal,
      });

      if (success) {
        await persistSubscription(agent);
      } else {
        // Non-zero exit without a thrown error — treat as "user
        // cancelled in the browser" rather than a crash.
        setCards((prev) => ({
          ...prev,
          [agent]: {
            ...prev[agent],
            loginRunning: false,
            loginError: "Sign-in didn't finish. Try again from this button.",
          },
        }));
      }
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [agent]: {
          ...prev[agent],
          loginError: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      loginCtrls.current[agent] = null;
      setCards((prev) => ({
        ...prev,
        [agent]: { ...prev[agent], loginRunning: false },
      }));
    }
  }

  function handleCancelSignIn(agent: CliAgentId) {
    loginCtrls.current[agent]?.abort();
    loginCtrls.current[agent] = null;
  }

  async function handleSignOut(agent: CliAgentId) {
    // We don't invoke the vendor CLI's `logout` subcommand here — not
    // every vendor has one, and even those that do would need extra
    // spawn plumbing for a purely cosmetic step (the user's token stays
    // in ~/.claude etc. regardless). Flipping the row back to api_key
    // mode is enough to stop Founder OS routing through the CLI.
    try {
      await db.upsertLlmSetting({
        provider: agent,
        mode: "api_key",
        enabled: false,
      });
      await refreshOne(agent);
      onChanged?.();
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [agent]: {
          ...prev[agent],
          loginError: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  return (
    <Card title="Subscriptions (Claude, ChatGPT, Gemini)">
      <p
        style={{
          margin: "0 0 14px",
          fontSize: 13,
          color: "#6B7280",
          lineHeight: 1.5,
        }}
      >
        Use your existing Claude Pro, ChatGPT Plus, or Gemini Advanced subscription instead of an
        API key. Founder OS spawns the vendor's CLI (<code>claude</code>, <code>codex</code>,{" "}
        <code>gemini</code>) to handle sign-in and inference. Usage counts against your monthly
        subscription, not API billing.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {CLI_AGENT_IDS.map((agent) => (
          <SubscriptionCard
            key={agent}
            agent={agent}
            state={cards[agent]}
            onConnect={() => handleConnect(agent)}
            onSignIn={() => handleSignIn(agent)}
            onCancelSignIn={() => handleCancelSignIn(agent)}
            onSignOut={() => handleSignOut(agent)}
            onRefresh={() => refreshOne(agent)}
          />
        ))}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────
// Per-agent card
// ──────────────────────────────────────────────

function SubscriptionCard({
  agent,
  state,
  onConnect,
  onSignIn,
  onCancelSignIn,
  onSignOut,
  onRefresh,
}: {
  agent: CliAgentId;
  state: CardState;
  /** CLI already authenticated — just persist the subscription-mode row. */
  onConnect: () => void;
  /** CLI not authenticated — drive the vendor's login subprocess. */
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
}) {
  const meta = CLI_AGENT_META[agent];
  const isDefault = agent === "anthropic";

  // UX state machine: loading → (not-installed | not-signed-in | signed-in)
  // with loginRunning as an orthogonal live-subprocess state.
  let badge: { text: string; bg: string; fg: string };
  if (state.loading) {
    badge = { text: "Checking…", bg: "#F3F4F6", fg: "#6B7280" };
  } else if (!state.status?.installed) {
    badge = { text: "Not installed", bg: "#FEF2F2", fg: "#991B1B" };
  } else if (state.saved?.mode === "subscription" && state.saved?.enabled) {
    badge = { text: "Signed in", bg: "#ECFDF5", fg: "#047857" };
  } else if (state.status.signedInHint) {
    badge = { text: "CLI ready — connect", bg: "#FFFBEB", fg: "#92400E" };
  } else {
    badge = { text: "Not signed in", bg: "#F3F4F6", fg: "#4B5563" };
  }

  const signedIn = state.saved?.mode === "subscription" && state.saved?.enabled;

  return (
    <div
      style={{
        padding: 16,
        border: "1px solid #E5E7EB",
        borderRadius: 8,
        background: "#FFFFFF",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{meta.displayName}</span>
            {isDefault && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: "#EEF2FF",
                  color: "#4338CA",
                  letterSpacing: 0.3,
                }}
              >
                DEFAULT
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: badge.bg,
                color: badge.fg,
              }}
            >
              {badge.text}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#6B7280", lineHeight: 1.5 }}>
            {meta.subscriptionName} · CLI: <code>{meta.binary}</code>
            {state.status?.version && (
              <>
                {" "}
                · <span style={{ color: "#9CA3AF" }}>{state.status.version}</span>
              </>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexShrink: 0,
            alignItems: "center",
          }}
        >
          {state.status && !state.status.installed && (
            <a
              href={meta.installUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 12,
                color: "#4338CA",
                textDecoration: "underline",
              }}
            >
              Install {meta.binary}
            </a>
          )}
          {/*
             Two paths for a fresh card on an installed CLI:
             - Credentials already on disk (vendor auto-auth, or user
               ran `<cli> login` in a terminal) → Connect, no subprocess.
               Critical for Claude Code 2.1.x which has no `claude login`
               command-line subcommand; running it would feed "login"
               to the model as a prompt.
             - No credentials yet → Sign in, which drives the vendor's
               login subcommand (works for Codex / Gemini). Falls back
               to showing an error with terminal instructions if the
               vendor doesn't have a login subcommand.
          */}
          {state.status?.installed &&
            !state.loginRunning &&
            !signedIn &&
            state.status.signedInHint && (
              <Button onClick={onConnect} size="sm">
                Connect
              </Button>
            )}
          {state.status?.installed &&
            !state.loginRunning &&
            !signedIn &&
            !state.status.signedInHint && (
              <Button onClick={onSignIn} size="sm">
                Sign in
              </Button>
            )}
          {state.loginRunning && (
            <Button onClick={onCancelSignIn} size="sm" variant="secondary">
              Cancel
            </Button>
          )}
          {signedIn && !state.loginRunning && (
            <Button onClick={onSignOut} size="sm" variant="secondary">
              Sign out
            </Button>
          )}
          <Button onClick={onRefresh} size="sm" variant="ghost">
            Refresh
          </Button>
        </div>
      </div>

      {state.loginError && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: "8px 10px",
            background: "#FEF2F2",
            color: "#991B1B",
            border: "1px solid #FECACA",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {state.loginError}
        </div>
      )}

      {(state.loginRunning || state.loginLog.length > 0) && (
        <pre
          style={{
            marginTop: 10,
            padding: "10px 12px",
            background: "#0B1020",
            color: "#E5E7EB",
            borderRadius: 6,
            fontSize: 12,
            maxHeight: 160,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {state.loginLog.length === 0
            ? "Waiting for CLI output…"
            : state.loginLog.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list, order does not change
                <div key={i} style={{ color: l.stream === "stderr" ? "#FCA5A5" : "#E5E7EB" }}>
                  {l.line}
                </div>
              ))}
        </pre>
      )}
    </div>
  );
}
