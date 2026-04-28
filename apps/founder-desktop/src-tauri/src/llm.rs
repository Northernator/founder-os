//! LLM streaming bridge.
//!
//! One public Tauri command — `llm_stream` — that calls the configured
//! provider and emits four event channels back to the WebView:
//!
//!   llm-delta   → `{ requestId, delta }`   every incoming token/chunk
//!   llm-done    → `{ requestId, text }`    stream closed cleanly
//!   llm-cancel  → `{ requestId, text }`    user cancelled; `text` is what
//!                                          we accumulated up to the cancel
//!   llm-error   → `{ requestId, message }` stream failed
//!
//! The frontend subscribes via `@tauri-apps/api/event` and filters on
//! `requestId` so multiple in-flight calls don't cross the streams.
//!
//! Three wire protocols cover all eight supported providers:
//!   * `anthropic`          → POST /v1/messages  (SSE, anthropic-specific events)
//!   * `openai_compatible`  → POST /v1/chat/completions (SSE, OpenAI format)
//!   * `gemini`             → POST :streamGenerateContent?alt=sse
//!
//! OpenAI-compatible covers OpenAI itself, DeepSeek, Grok/xAI, Kimi/Moonshot,
//! Perplexity, and Ollama's `/v1` shim — so adding a new compatible provider
//! is a TypeScript-only change to `packages/llm-providers/src/catalog.ts`.
//!
//! Cancellation: a Tauri-managed `CancelRegistry` holds an `Arc<(AtomicBool,
//! Notify)>` per in-flight stream keyed on `requestId`. `llm_cancel` flips the
//! flag AND fires `notify_waiters()` — the SSE reader races `stream.next()`
//! against `notified()` in a `tokio::select!` so a stalled mid-await unblocks
//! immediately rather than waiting for the next provider byte. Dropping the
//! response closes the TLS connection, stopping further token generation.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

// ──────────────────────────────────────────────
// Payloads
// ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStreamRequest {
    /// Client-generated correlation id. Present on every emitted event so the
    /// WebView can filter streams from concurrent sends.
    pub request_id: String,
    /// Wire protocol to use: "anthropic" | "openai_compatible" | "gemini".
    /// Mirrors `LlmProviderKind` in packages/llm-providers.
    pub kind: String,
    /// Friendly provider id ("anthropic", "ollama", etc.). Included in error
    /// messages so the user knows which backend failed.
    pub provider: String,
    pub api_key: Option<String>,
    /// Base URL — always provided by the caller; it falls back to the catalog
    /// default on the TS side before invoking.
    pub base_url: String,
    pub model: String,
    pub messages: Vec<LlmMessage>,
    /// Optional top-level system prompt. When the messages array also contains
    /// a `system` role, we prefer that (matches OpenAI convention); this field
    /// is useful for Anthropic where system is passed separately.
    pub system: Option<String>,
    pub max_tokens: Option<u32>,
    /// 0.0 – 1.0. Passed through only when the provider honors it.
    pub temperature: Option<f32>,
    /// Opt-in to the provider's server-side web search. Honored only for
    /// Anthropic today (via `web_search_20250305`). Other branches ignore
    /// it silently so callers can set this provider-agnostically.
    pub enable_web_search: Option<bool>,
    /// Upper bound on web searches per request. Defaults to 5 inside the
    /// Anthropic branch when this is None.
    pub web_search_max_uses: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeltaEvent {
    request_id: String,
    delta: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    request_id: String,
    text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    request_id: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CancelEvent {
    request_id: String,
    /// Tokens accumulated before the cancel flag was observed. The UI uses
    /// this to leave the partial response visible with a "cancelled" label
    /// rather than wiping back to the original button.
    text: String,
}

// ──────────────────────────────────────────────
// Cancel registry
// ──────────────────────────────────────────────

/// Per-request cancellation state, keyed by `requestId`.
///
/// Each entry pairs an `AtomicBool` (cheap between-event checks) with a
/// `tokio::sync::Notify` (wakes the `select!` branch inside `consume_sse` when
/// the stream is mid-`stream.next().await` and can't observe the flag).
///
/// `llm_stream` registers a fresh entry before spawning, hands an `Arc` clone
/// to the SSE reader, and removes the entry on completion. `llm_cancel` flips
/// the flag AND fires `notify_waiters()` so a stalled `.await` unblocks within
/// microseconds rather than waiting for the next provider byte.
///
/// The `Mutex` only guards the `HashMap` ops; neither the `AtomicBool` nor the
/// `Notify` need the map lock once cloned. Contention is negligible — three
/// map touches per stream lifetime.
#[derive(Default)]
pub struct CancelRegistry {
    flags: Mutex<HashMap<String, Arc<(AtomicBool, Notify)>>>,
}

impl CancelRegistry {
    /// Insert a fresh `(flag, notify)` pair for `request_id` and return an
    /// `Arc` clone the stream reader checks on every iteration.
    pub(crate) fn register(&self, request_id: &str) -> Arc<(AtomicBool, Notify)> {
        let entry = Arc::new((AtomicBool::new(false), Notify::new()));
        if let Ok(mut map) = self.flags.lock() {
            // Replace rather than fail on duplicate id — a paranoid caller
            // might reuse an id after a cancel. The new stream gets a fresh
            // entry; any old Arc reference is harmlessly orphaned.
            map.insert(request_id.to_string(), entry.clone());
        }
        entry
    }

    /// Drop the registry entry for `request_id`. Idempotent.
    pub(crate) fn remove(&self, request_id: &str) {
        if let Ok(mut map) = self.flags.lock() {
            map.remove(request_id);
        }
    }

    /// Flip the flag AND wake any `notified()` future waiting inside
    /// `consume_sse`. No-op if the id isn't known — the stream may have
    /// already finished, which is a perfectly valid race.
    fn cancel(&self, request_id: &str) -> bool {
        if let Ok(map) = self.flags.lock() {
            if let Some(entry) = map.get(request_id) {
                entry.0.store(true, Ordering::SeqCst);
                // Wake the select! branch inside consume_sse so a stalled
                // stream.next().await unblocks immediately.
                entry.1.notify_waiters();
                return true;
            }
        }
        false
    }
}

/// Ask a live stream to stop. The spawned task will observe the flag on its
/// next SSE event, emit `llm-cancel`, and exit. Returns `true` if the id
/// matched an in-flight stream, `false` if it was already gone (already
/// finished or never started) — the caller doesn't really care, the UI just
/// tears down its listeners either way.
#[tauri::command]
pub fn llm_cancel(request_id: String, registry: State<'_, CancelRegistry>) -> bool {
    registry.cancel(&request_id)
}

// ──────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────

/// Start a streaming LLM call. Returns as soon as the HTTP request is issued;
/// tokens arrive asynchronously via the `llm-delta` channel.
#[tauri::command]
pub async fn llm_stream(
    app: AppHandle,
    registry: State<'_, CancelRegistry>,
    req: LlmStreamRequest,
) -> Result<(), String> {
    // Register the cancel flag BEFORE we spawn — the JS side might invoke
    // `llm_cancel` immediately after `invoke("llm_stream")` resolves. If we
    // registered inside the spawned task we'd have a race where the cancel
    // comes in before the flag exists and the stream runs to completion.
    let flag = registry.register(&req.request_id);

    // Clone what the background task needs. `State<CancelRegistry>` can't
    // cross the `spawn` boundary (it's scoped to the request), so we clone
    // the `AppHandle`, grab a static reference to the managed state, and
    // let the spawned task hit the registry directly for the cleanup.
    let handle = app.clone();
    tokio::spawn(async move {
        let request_id = req.request_id.clone();
        let result = dispatch(&handle, req, flag).await;
        match result {
            Err(message) => {
                let _ = handle.emit(
                    "llm-error",
                    ErrorEvent {
                        request_id: request_id.clone(),
                        message,
                    },
                );
            }
            Ok(()) => { /* success path emitted done/cancel itself */ }
        }
        // Always clean up the cancel entry — otherwise the HashMap grows
        // unboundedly on a long-running session.
        if let Some(reg) = handle.try_state::<CancelRegistry>() {
            reg.remove(&request_id);
        }
    });
    Ok(())
}

async fn dispatch(
    app: &AppHandle,
    req: LlmStreamRequest,
    cancel: Arc<(AtomicBool, Notify)>,
) -> Result<(), String> {
    match req.kind.as_str() {
        "anthropic" => stream_anthropic(app, req, cancel).await,
        "openai_compatible" => stream_openai_compatible(app, req, cancel).await,
        "gemini" => stream_gemini(app, req, cancel).await,
        other => Err(format!("unknown provider kind: {other}")),
    }
}

fn emit_delta(app: &AppHandle, request_id: &str, delta: &str) {
    if delta.is_empty() {
        return;
    }
    let _ = app.emit(
        "llm-delta",
        DeltaEvent {
            request_id: request_id.to_string(),
            delta: delta.to_string(),
        },
    );
}

fn emit_done(app: &AppHandle, request_id: &str, text: String) {
    let _ = app.emit(
        "llm-done",
        DoneEvent {
            request_id: request_id.to_string(),
            text,
        },
    );
}

/// Emit a cancel event with whatever partial text we managed to accumulate
/// before the flag flipped. The UI treats this like a friendly `done` —
/// listeners clean up and the partial stays visible as "cancelled".
fn emit_cancel(app: &AppHandle, request_id: &str, text: String) {
    let _ = app.emit(
        "llm-cancel",
        CancelEvent {
            request_id: request_id.to_string(),
            text,
        },
    );
}

// ──────────────────────────────────────────────
// Shared HTTP client
// ──────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // Generous timeouts — LLM calls can sit idle for seconds before the
        // first token arrives, especially for reasoning models.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("failed to build http client: {e}"))
}

/// Read an SSE-formatted byte stream, yielding one logical event at a time as
/// its `data:` payload (already trimmed of the prefix).
///
/// Buffers bytes (not chars) — chunked HTTP responses can split a multi-byte
/// UTF-8 character across chunk boundaries, which `from_utf8_lossy` would
/// silently corrupt with replacement chars. SSE framing (`\n\n`, `data:`) is
/// ASCII, so we scan bytes for the delimiter and only UTF-8-decode completed
/// events, which are always at valid char boundaries.
///
/// Cancellation — three layers:
///
/// 1. **Pre-await flag check** — bail immediately if already cancelled before
///    we even start waiting for the next chunk.
/// 2. **`select!` preemption** — races `stream.next()` against
///    `cancel_notify.notified()`. When `llm_cancel` fires `notify_waiters()`,
///    this arm wins and we return before the provider sends another byte. This
///    is the fix for stalled providers: a slow `.await` is now bounded by the
///    cancel signal, not by the next chunk arriving.
/// 3. **Between-event flag check** — catches the case where the cancel arrives
///    after we started processing a chunk but before we finish parsing its
///    events (e.g. a chunk with many events inside it).
///
/// On any cancel path we return `Ok(())` cleanly. Dropping the response closes
/// the TLS connection, stopping the provider from generating more tokens.
/// The caller checks the flag afterwards and emits `llm-cancel` vs `llm-done`.
async fn consume_sse<F>(
    resp: reqwest::Response,
    cancel_flag: &AtomicBool,
    cancel_notify: &Notify,
    mut on_event: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<ConsumeAction, String>,
{
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(8192);

    loop {
        // Pre-register interest in the Notify BEFORE the flag check. This
        // closes the race: if notify_waiters() fires between the flag-check
        // below and the select! poll, the notified() future still resolves
        // immediately (enable() stamps the waiter before it's polled).
        let mut notified = std::pin::pin!(cancel_notify.notified());
        notified.as_mut().enable();

        if cancel_flag.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Race the next HTTP chunk against the cancel signal. `biased` means
        // tokio always polls the cancel arm first — if both are ready at the
        // same instant we prefer cancel, which is the safe choice.
        let chunk = tokio::select! {
            biased;
            _ = &mut notified => return Ok(()), // cancel arrived mid-await
            c = stream.next() => c,
        };

        let bytes = match chunk {
            Some(Ok(b)) => b,
            Some(Err(e)) => return Err(format!("stream read error: {e}")),
            None => break, // stream ended cleanly
        };

        buf.extend_from_slice(&bytes);

        // SSE events are separated by a blank line (two consecutive newlines).
        // Walk the byte buffer, pull out completed events, keep the tail.
        while let Some(idx) = find_double_newline(&buf) {
            let event_bytes: Vec<u8> = buf.drain(..idx + 2).collect();
            let event = String::from_utf8_lossy(&event_bytes);
            for line in event.lines() {
                let line = line.trim_end_matches('\r');
                if let Some(rest) = line.strip_prefix("data:") {
                    let payload = rest.trim_start();
                    match on_event(payload)? {
                        ConsumeAction::Continue => {}
                        ConsumeAction::Stop => return Ok(()),
                    }
                    // Between-event check: Anthropic fires a dozen-plus
                    // events per second, so checking here drops abort
                    // latency to a handful of ms even within a single chunk.
                    if cancel_flag.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                }
            }
        }
    }

    // If the stream ends without a trailing blank line, process whatever's left.
    if !buf.is_empty() {
        let tail = String::from_utf8_lossy(&buf);
        for line in tail.lines() {
            if let Some(rest) = line.trim_end_matches('\r').strip_prefix("data:") {
                let payload = rest.trim_start();
                match on_event(payload)? {
                    ConsumeAction::Continue => {}
                    ConsumeAction::Stop => return Ok(()),
                }
            }
        }
    }
    Ok(())
}

/// First index of a blank-line separator (`\n\n`) in `buf`, or `None`. We
/// accept bare LF since every provider we target emits `\n\n` (not `\r\n\r\n`)
/// despite the spec allowing both.
fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

enum ConsumeAction {
    Continue,
    Stop,
}

// ──────────────────────────────────────────────
// Anthropic
// ──────────────────────────────────────────────

async fn stream_anthropic(
    app: &AppHandle,
    req: LlmStreamRequest,
    cancel: Arc<(AtomicBool, Notify)>,
) -> Result<(), String> {
    let api_key = req
        .api_key
        .as_ref()
        .ok_or_else(|| "anthropic: missing api key".to_string())?;

    // Anthropic takes system as a top-level field, not a message. Prefer the
    // explicit `system` on the request; fall back to any system message that
    // snuck into `messages`.
    let (system, messages) = split_system(&req);
    let messages_json: Vec<JsonValue> = messages
        .iter()
        .map(|m| json!({ "role": m.role, "content": m.content }))
        .collect();

    let mut body = json!({
        "model": req.model,
        "messages": messages_json,
        "stream": true,
        "max_tokens": req.max_tokens.unwrap_or(4096),
    });
    if let Some(sys) = system {
        body["system"] = JsonValue::String(sys);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    // Opt in to Anthropic's server-side web search when the caller asks.
    // The model decides whether to actually invoke the tool — we just make
    // it available. `max_uses` caps cost; default is conservative because
    // each search round-trips to Anthropic's crawler and adds billed
    // tokens for the results payload.
    if req.enable_web_search.unwrap_or(false) {
        let max_uses = req.web_search_max_uses.unwrap_or(5);
        body["tools"] = json!([
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": max_uses,
            }
        ]);
    }

    let url = format!("{}/v1/messages", req.base_url.trim_end_matches('/'));
    let resp = http_client()?
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic {status}: {text}"));
    }

    let mut accumulated = String::new();
    let request_id = req.request_id.clone();
    let (cancel_flag, cancel_notify) = &*cancel;

    consume_sse(resp, cancel_flag, cancel_notify, |payload| {
        if payload == "[DONE]" {
            return Ok(ConsumeAction::Stop);
        }
        let value: JsonValue = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return Ok(ConsumeAction::Continue),
        };
        let event_type = value.get("type").and_then(|t| t.as_str());
        match event_type {
            // Text streaming — the bread and butter.
            Some("content_block_delta") => {
                if let Some(text) = value
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(|t| t.as_str())
                {
                    accumulated.push_str(text);
                    emit_delta(app, &request_id, text);
                }
                // input_json_delta on a server_tool_use block (the partial
                // search query as it's generated). We don't surface this —
                // the query can look noisy mid-stream and the user cares
                // about the "we searched" signal, not the exact words.
            }
            // New content block started. For `server_tool_use` (the model
            // firing a web search) and `web_search_tool_result` (results
            // coming back) we emit a short inline indicator so the chat
            // bubble shows something during the otherwise-silent tool
            // round-trip. The chat UI renders with `whiteSpace: pre-wrap`,
            // so newlines preserve cleanly.
            Some("content_block_start") => {
                if let Some(block) = value.get("content_block") {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("server_tool_use") => {
                            if block.get("name").and_then(|n| n.as_str())
                                == Some("web_search")
                            {
                                let marker = "\n\n🔍 _Searching the web…_\n\n";
                                accumulated.push_str(marker);
                                emit_delta(app, &request_id, marker);
                            }
                        }
                        Some("web_search_tool_result") => {
                            // Count results so the marker is informative
                            // without dumping URLs inline (those arrive as
                            // citations in subsequent text blocks anyway).
                            let count = block
                                .get("content")
                                .and_then(|c| c.as_array())
                                .map(|a| a.len())
                                .unwrap_or(0);
                            let marker = if count == 1 {
                                "🔎 _1 result_\n\n".to_string()
                            } else {
                                format!("🔎 _{count} results_\n\n")
                            };
                            accumulated.push_str(&marker);
                            emit_delta(app, &request_id, &marker);
                        }
                        _ => {}
                    }
                }
            }
            // Everything else (message_start, ping, content_block_stop,
            // message_delta with stop_reason, message_stop) we let slide.
            // Stream closure drives our done/cancel decision.
            _ => {}
        }
        Ok(ConsumeAction::Continue)
    })
    .await?;

    if cancel_flag.load(Ordering::SeqCst) {
        emit_cancel(app, &req.request_id, accumulated);
    } else {
        emit_done(app, &req.request_id, accumulated);
    }
    Ok(())
}

// ──────────────────────────────────────────────
// OpenAI-compatible (OpenAI / DeepSeek / Grok / Kimi / Perplexity / Ollama v1)
// ──────────────────────────────────────────────

async fn stream_openai_compatible(
    app: &AppHandle,
    req: LlmStreamRequest,
    cancel: Arc<(AtomicBool, Notify)>,
) -> Result<(), String> {
    let (system, messages) = split_system(&req);
    let mut openai_messages: Vec<JsonValue> = Vec::new();
    if let Some(sys) = system {
        openai_messages.push(json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        openai_messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut body = json!({
        "model": req.model,
        "messages": openai_messages,
        "stream": true,
    });
    if let Some(mt) = req.max_tokens {
        body["max_tokens"] = json!(mt);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }

    let url = format!(
        "{}/chat/completions",
        req.base_url.trim_end_matches('/')
    );
    let mut builder = http_client()?
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);
    if let Some(key) = &req.api_key {
        // Ollama accepts either no Authorization header or a dummy one. Other
        // compatible providers all use standard Bearer auth.
        if !key.is_empty() {
            builder = builder.header("authorization", format!("Bearer {key}"));
        }
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("{}: request failed: {e}", req.provider))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{} {status}: {text}", req.provider));
    }

    let mut accumulated = String::new();
    let request_id = req.request_id.clone();
    let (cancel_flag, cancel_notify) = &*cancel;

    consume_sse(resp, cancel_flag, cancel_notify, |payload| {
        if payload == "[DONE]" {
            return Ok(ConsumeAction::Stop);
        }
        let value: JsonValue = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return Ok(ConsumeAction::Continue),
        };
        // OpenAI's chat.completion.chunk shape: choices[0].delta.content.
        // Reasoning-model variants sometimes include `reasoning` or empty
        // delta objects — we only surface `content`, matching what the chat
        // bubble knows how to render.
        if let Some(choice) = value
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
        {
            if let Some(delta_text) = choice
                .get("delta")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
            {
                if !delta_text.is_empty() {
                    accumulated.push_str(delta_text);
                    emit_delta(app, &request_id, delta_text);
                }
            }
        }
        Ok(ConsumeAction::Continue)
    })
    .await?;

    if cancel_flag.load(Ordering::SeqCst) {
        emit_cancel(app, &req.request_id, accumulated);
    } else {
        emit_done(app, &req.request_id, accumulated);
    }
    Ok(())
}

// ──────────────────────────────────────────────
// Google Gemini
// ──────────────────────────────────────────────

async fn stream_gemini(
    app: &AppHandle,
    req: LlmStreamRequest,
    cancel: Arc<(AtomicBool, Notify)>,
) -> Result<(), String> {
    let api_key = req
        .api_key
        .as_ref()
        .ok_or_else(|| "gemini: missing api key".to_string())?;

    // Gemini uses user/model role names, not user/assistant. System prompts go
    // in `systemInstruction`, not in `contents`.
    let (system, messages) = split_system(&req);
    let contents: Vec<JsonValue> = messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            json!({
                "role": role,
                "parts": [{ "text": m.content }],
            })
        })
        .collect();

    let mut body = json!({ "contents": contents });
    if let Some(sys) = system {
        body["systemInstruction"] = json!({ "parts": [{ "text": sys }] });
    }
    let mut gen_config = serde_json::Map::new();
    if let Some(mt) = req.max_tokens {
        gen_config.insert("maxOutputTokens".to_string(), json!(mt));
    }
    if let Some(t) = req.temperature {
        gen_config.insert("temperature".to_string(), json!(t));
    }
    if !gen_config.is_empty() {
        body["generationConfig"] = JsonValue::Object(gen_config);
    }

    // Gemini authenticates via query string, not header. `alt=sse` opts into
    // server-sent events (default is a JSON array, which we can't stream).
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse&key={}",
        req.base_url.trim_end_matches('/'),
        req.model,
        api_key
    );

    let resp = http_client()?
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gemini {status}: {text}"));
    }

    let mut accumulated = String::new();
    let request_id = req.request_id.clone();
    let (cancel_flag, cancel_notify) = &*cancel;

    consume_sse(resp, cancel_flag, cancel_notify, |payload| {
        let value: JsonValue = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => return Ok(ConsumeAction::Continue),
        };
        // Gemini's streaming shape: candidates[0].content.parts[*].text. Unlike
        // OpenAI there's no [DONE] sentinel — we rely on the stream closing,
        // and on finishReason landing in the final chunk (which we don't need).
        if let Some(parts) = value
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|cand| cand.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        accumulated.push_str(text);
                        emit_delta(app, &request_id, text);
                    }
                }
            }
        }
        Ok(ConsumeAction::Continue)
    })
    .await?;

    if cancel_flag.load(Ordering::SeqCst) {
        emit_cancel(app, &req.request_id, accumulated);
    } else {
        emit_done(app, &req.request_id, accumulated);
    }
    Ok(())
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/// Pull system prompt out of the request, combining the explicit `system`
/// field with any `role:"system"` message in the array. Non-system messages
/// are returned in their original order.
fn split_system(req: &LlmStreamRequest) -> (Option<String>, Vec<&LlmMessage>) {
    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = &req.system {
        if !s.is_empty() {
            parts.push(s.clone());
        }
    }
    let mut rest: Vec<&LlmMessage> = Vec::new();
    for m in &req.messages {
        if m.role == "system" {
            parts.push(m.content.clone());
        } else {
            rest.push(m);
        }
    }
    let system = if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    };
    (system, rest)
}
