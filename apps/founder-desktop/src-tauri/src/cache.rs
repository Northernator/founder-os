//! Prompt Master persistent cache.
//!
//! The TypeScript side of `@founder-os/prompt-master` exposes a
//! `CacheBackend` interface (get / put / inspect). The desktop app
//! provides a backend that persists across window restarts by storing
//! entries in the existing `founder.db` SQLite database via the three
//! Tauri commands in this module:
//!
//!   pm_cache_get(hash)          → Option<CachedEntry>  (also bumps last_used)
//!   pm_cache_put(hash, body, …) → ()                   (eviction inline)
//!   pm_cache_inspect()          → CacheStats           (entries, bytes, cap)
//!
//! Schema lives in `migrations/0007-prompt-master-cache.sql` and is
//! applied by the tauri-plugin-sql migration runner at app start, so
//! the table is guaranteed to exist by the time any command fires.
//!
//! Why a separate `rusqlite` connection instead of reusing
//! `tauri-plugin-sql`'s pool: the plugin's pool is a sqlx Pool kept
//! private inside the plugin. Going through it from Rust would mean
//! depending on the plugin's internal types. A second connection is
//! simpler and SQLite handles intra-process locking automatically; the
//! cache traffic is too low (one read + one write per LLM call) to
//! contend.
//!
//! Eviction runs inside `pm_cache_put`. When `total_bytes` exceeds the
//! 200MB cap we delete the bottom 10% by `last_used ASC`. Doing it on
//! write amortises the cost — `get` stays a single SELECT + UPDATE.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

use crate::pricing::dollars_for_tokens_saved;

/// Maximum bytes the cache is allowed to occupy. 200MB matches the cap
/// hinted at in the user-facing CacheStats; the optimized prompts we
/// actually store are tiny (low-kB system prompts) so this is more of a
/// safety net than a hot path.
const CACHE_CAP_BYTES: i64 = 200 * 1024 * 1024;

/// Fraction of the cache to evict in one sweep when the cap is exceeded.
/// Keeps eviction infrequent — we run it inside `pm_cache_put` rather
/// than on a timer, so doing 10% per overflow means we only evict every
/// ~10 puts after the cache fills, instead of one row per put.
const EVICTION_FRACTION: f64 = 0.10;

#[derive(Default)]
pub struct CacheState {
    /// Lazily-initialised connection. None until the first command runs
    /// — opening a SQLite connection requires the resolved `app_config_dir`
    /// path which only exists once Tauri has finished setup.
    conn: Mutex<Option<Connection>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedEntry {
    pub optimized: String,
    pub stored_at: String,
    pub bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub entries: i64,
    pub total_bytes: i64,
    pub cap_bytes: i64,
}

/// Lifetime aggregate of `prompt_master_events` for the Options-tab
/// stats card. `cache_hit_rate` is a 0..1 ratio computed over optimize
/// events only; fallback events don't count toward the denominator
/// because the cache never had a chance to hit. NaN is impossible —
/// when there are no optimize events we return 0.0.
///
/// Dollar fields multiply each (provider, model) bucket's tokens_saved
/// by its input list price (see crate::pricing) — events with NULL
/// provider/model fall back to a midrange bucket so old/cache-hit rows
/// don't render as $0. The numbers are estimates: tokens_saved is
/// itself a chars/4 heuristic, and the pricing table tracks list rates,
/// not the per-account discounts a real invoice might apply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStats {
    pub lifetime_tokens_saved: i64,
    pub total_events: i64,
    pub cache_hit_rate: f64,
    pub top_contexts: Vec<TopContext>,
    /// Top ventures by lifetime tokens saved. Excludes rows where
    /// venture_id is NULL — events emitted before migration 0009 (and
    /// global-scope events with no venture in scope) live on in the
    /// table for lifetime totals but don't appear here.
    pub top_ventures: Vec<TopVenture>,
    /// Estimated lifetime USD saved across every event in the table.
    pub estimated_dollars_saved_lifetime: f64,
    /// Top 5 ventures ranked by estimated dollars saved (not tokens).
    /// Different from `top_ventures` because a venture sending a lot of
    /// tokens against a cheap model can save fewer dollars than a
    /// venture sending fewer tokens against an expensive one.
    pub top_ventures_by_dollars: Vec<TopVentureDollars>,
    /// Top 3 (provider, model) pairs by estimated dollars saved.
    pub top_models_by_dollars: Vec<TopModelDollars>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopContext {
    pub context: String,
    pub tokens_saved: i64,
    pub count: i64,
    /// Estimated USD saved for this context, summed across the
    /// (provider, model) buckets that emitted under it. Approximate —
    /// see EventStats doc.
    pub dollars_saved: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopVenture {
    pub venture_id: String,
    pub tokens_saved: i64,
    pub events: i64,
    /// Estimated USD saved for this venture, summed across
    /// (provider, model) buckets. Approximate — see EventStats doc.
    pub dollars_saved: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopVentureDollars {
    pub venture_id: String,
    pub dollars_saved: f64,
    pub tokens_saved: i64,
    pub events: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopModelDollars {
    /// Provider id ("anthropic", "openai", ...) or "unknown" when the
    /// row pre-dates migration 0010.
    pub provider: String,
    /// Model id (catalog model string) or "unknown" for legacy rows.
    pub model: String,
    pub dollars_saved: f64,
    pub tokens_saved: i64,
    pub events: i64,
}

/// Bound for the in-table event log. Older rows are pruned inside
/// `pm_event_log`. 10k rows × ~120 bytes ≈ 1.2MB — easily ignorable
/// next to the 200MB cache cap, but enough headroom that aggregates
/// across "lifetime" stay meaningful for any individual user.
const EVENT_LOG_CAP: i64 = 10_000;

/// Resolve the `founder.db` path the same way `tauri-plugin-sql` does.
/// The plugin treats the `sqlite:` URI as relative to `app_config_dir`,
/// so we follow the same convention. Both connections then point at the
/// same physical file.
fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join("founder.db"))
}

/// Acquire a connection, opening it if this is the first call. The lock
/// is held for the duration of every command — fine because each command
/// is a tiny transaction and the WebView never issues more than one cache
/// op at a time per `optimize()` call.
fn with_conn<R, F>(state: &State<'_, CacheState>, app: &tauri::AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&Connection) -> Result<R, String>,
{
    let mut guard = state
        .conn
        .lock()
        .map_err(|_| "cache mutex poisoned".to_string())?;
    if guard.is_none() {
        let path = resolve_db_path(app)?;
        let conn = Connection::open(&path).map_err(|e| {
            format!("open cache db at {}: {}", path.display(), e)
        })?;
        // Use WAL so reads (the get path) don't block writes (the put
        // path) and don't fight the tauri-plugin-sql pool. WAL is set
        // per-database on disk and is sticky once turned on, so calling
        // it on every open is harmless after the first time.
        let _: String = conn
            .query_row("PRAGMA journal_mode=WAL;", [], |r| r.get(0))
            .map_err(|e| format!("set WAL: {e}"))?;
        *guard = Some(conn);
    }
    let conn = guard.as_ref().expect("connection just initialised");
    f(conn)
}

/// Look up a cached entry. On hit, bump `last_used` so the LRU eviction
/// policy treats this row as fresh.
#[tauri::command]
pub fn pm_cache_get(
    app: tauri::AppHandle,
    state: State<'_, CacheState>,
    hash: String,
) -> Result<Option<CachedEntry>, String> {
    with_conn(&state, &app, |conn| {
        let row = conn
            .query_row(
                "SELECT optimized, stored_at, bytes FROM prompt_master_cache WHERE hash = ?1",
                params![hash],
                |r| {
                    Ok(CachedEntry {
                        optimized: r.get(0)?,
                        stored_at: r.get(1)?,
                        bytes: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("cache get: {e}"))?;

        if row.is_some() {
            // Best-effort touch — failing to bump last_used would just
            // make this entry an earlier eviction candidate; it's not
            // worth surfacing the error to the caller.
            let now = current_iso();
            let _ = conn.execute(
                "UPDATE prompt_master_cache SET last_used = ?1 WHERE hash = ?2",
                params![now, hash],
            );
        }
        Ok(row)
    })
}

/// Insert or replace a cache entry, then run the eviction sweep when
/// the total exceeds the cap.
#[tauri::command]
pub fn pm_cache_put(
    app: tauri::AppHandle,
    state: State<'_, CacheState>,
    hash: String,
    optimized: String,
    stored_at: String,
    bytes: i64,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        let now = current_iso();
        conn.execute(
            "INSERT OR REPLACE INTO prompt_master_cache \
             (hash, optimized, stored_at, bytes, last_used) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![hash, optimized, stored_at, bytes, now],
        )
        .map_err(|e| format!("cache put: {e}"))?;

        // Eviction: total bytes guard. SUM is cheap because the index
        // on last_used keeps the table compact and SQLite caches the
        // page set after the first scan.
        let total: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(bytes), 0) FROM prompt_master_cache",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("cache size: {e}"))?;

        if total > CACHE_CAP_BYTES {
            let entries: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM prompt_master_cache",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("cache count: {e}"))?;

            // Evict at least one row, otherwise a single oversized
            // entry could leave the cap permanently exceeded.
            let to_drop = ((entries as f64) * EVICTION_FRACTION).ceil() as i64;
            let to_drop = to_drop.max(1);

            conn.execute(
                "DELETE FROM prompt_master_cache WHERE hash IN (\
                   SELECT hash FROM prompt_master_cache \
                   ORDER BY last_used ASC LIMIT ?1)",
                params![to_drop],
            )
            .map_err(|e| format!("cache evict: {e}"))?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn pm_cache_inspect(
    app: tauri::AppHandle,
    state: State<'_, CacheState>,
) -> Result<CacheStats, String> {
    with_conn(&state, &app, |conn| {
        let (entries, total_bytes): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM prompt_master_cache",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| format!("cache inspect: {e}"))?;
        Ok(CacheStats {
            entries,
            total_bytes,
            cap_bytes: CACHE_CAP_BYTES,
        })
    })
}

/// Append a telemetry event row, then prune the log back to
/// `EVENT_LOG_CAP` rows (newest by id). Errors are returned as strings
/// so the TS sink can swallow them — telemetry must never break
/// optimize().
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pm_event_log(
    app: tauri::AppHandle,
    state: State<'_, CacheState>,
    event: String,
    context: String,
    tokens_saved: i64,
    cache_hit: bool,
    transport: Option<String>,
    latency_ms: Option<i64>,
    venture_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    with_conn(&state, &app, |conn| {
        let now = current_iso();
        let cache_hit_int: i64 = if cache_hit { 1 } else { 0 };
        conn.execute(
            "INSERT INTO prompt_master_events \
             (ts, event, context, tokens_saved, cache_hit, transport, latency_ms, venture_id, provider, model) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                now,
                event,
                context,
                tokens_saved,
                cache_hit_int,
                transport,
                latency_ms,
                venture_id,
                provider,
                model
            ],
        )
        .map_err(|e| format!("event log insert: {e}"))?;

        // Cap the table opportunistically. AUTOINCREMENT means newer rows
        // always have a higher id, so "keep last N by id DESC" matches
        // "keep most recent N by ts" without needing the ts index.
        // The subquery is bounded by LIMIT so this is O(N) at worst, and
        // SQLite skips the DELETE entirely when nothing matches.
        conn.execute(
            "DELETE FROM prompt_master_events \
             WHERE id NOT IN (\
               SELECT id FROM prompt_master_events ORDER BY id DESC LIMIT ?1\
             )",
            params![EVENT_LOG_CAP],
        )
        .map_err(|e| format!("event log prune: {e}"))?;

        Ok(())
    })
}

/// Aggregate the event log for the Options-tab stats card. Three
/// queries because each one is a different shape and combining them
/// inside SQLite would be uglier than three indexed scans. All three
/// run inside the same lock so the numbers are mutually consistent.
#[tauri::command]
pub fn pm_event_stats(
    app: tauri::AppHandle,
    state: State<'_, CacheState>,
) -> Result<EventStats, String> {
    with_conn(&state, &app, |conn| {
        // Lifetime tokens saved + total event count. SUM over an empty
        // table returns NULL, so COALESCE pins it to 0 to avoid a NULL
        // → i64 conversion error.
        let (lifetime_tokens_saved, total_events): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(tokens_saved), 0), COUNT(*) FROM prompt_master_events",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| format!("event stats totals: {e}"))?;

        // Cache hit rate: hits / optimize-events. Fallback events are
        // excluded — they never reach the cache and would skew the
        // ratio downward in a way that doesn't reflect the cache's
        // actual effectiveness.
        let (optimize_count, hit_count): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(cache_hit), 0) \
                 FROM prompt_master_events WHERE event = 'optimize'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| format!("event stats hit-rate: {e}"))?;
        let cache_hit_rate = if optimize_count > 0 {
            (hit_count as f64) / (optimize_count as f64)
        } else {
            0.0
        };

        // Granular roll-up: every (context, venture, provider, model)
        // bucket with its summed tokens_saved + event count. We do the
        // pricing math in Rust because the SQL doesn't know per-model
        // rates — see crate::pricing. One scan, then we fold into the
        // four shapes the UI needs (lifetime $, top contexts, top
        // ventures, top models). Cheap because EVENT_LOG_CAP keeps the
        // table at ≤10k rows and the (provider, model) index covers
        // the GROUP BY.
        struct Bucket {
            context: String,
            venture_id: Option<String>,
            provider: Option<String>,
            model: Option<String>,
            tokens_saved: i64,
            events: i64,
        }
        let mut bstmt = conn
            .prepare(
                "SELECT context, venture_id, provider, model, \
                        COALESCE(SUM(tokens_saved), 0), COUNT(*) \
                 FROM prompt_master_events \
                 WHERE event = 'optimize' \
                 GROUP BY context, venture_id, provider, model",
            )
            .map_err(|e| format!("event stats buckets prepare: {e}"))?;
        let brows = bstmt
            .query_map([], |r| {
                Ok(Bucket {
                    context: r.get(0)?,
                    venture_id: r.get(1)?,
                    provider: r.get(2)?,
                    model: r.get(3)?,
                    tokens_saved: r.get(4)?,
                    events: r.get(5)?,
                })
            })
            .map_err(|e| format!("event stats buckets query: {e}"))?;

        // Aggregator: roll the granular buckets up into the four
        // dimensions the EventStats response carries. Each accumulator
        // is keyed by its grouping field and tracks (tokens, dollars,
        // events) so a later sort + truncate gives us the top-N panels.
        struct Acc {
            tokens_saved: i64,
            dollars_saved: f64,
            events: i64,
        }
        let mut by_context: HashMap<String, Acc> = HashMap::new();
        let mut by_venture: HashMap<String, Acc> = HashMap::new();
        let mut by_model: HashMap<(String, String), Acc> = HashMap::new();
        let mut estimated_dollars_saved_lifetime: f64 = 0.0;

        for row in brows {
            let b = row.map_err(|e| format!("event stats bucket row: {e}"))?;
            let dollars = dollars_for_tokens_saved(
                b.provider.as_deref(),
                b.model.as_deref(),
                b.tokens_saved,
            );
            estimated_dollars_saved_lifetime += dollars;

            // Context bucket — every row contributes (no NULL filter).
            let ctx = by_context.entry(b.context.clone()).or_insert(Acc {
                tokens_saved: 0,
                dollars_saved: 0.0,
                events: 0,
            });
            ctx.tokens_saved += b.tokens_saved;
            ctx.dollars_saved += dollars;
            ctx.events += b.events;

            // Venture bucket — skip NULL venture_id rows. Events emitted
            // before migration 0009 (and global-scope events) live in
            // the lifetime totals but don't get attributed to any
            // venture.
            if let Some(vid) = b.venture_id.clone() {
                let v = by_venture.entry(vid).or_insert(Acc {
                    tokens_saved: 0,
                    dollars_saved: 0.0,
                    events: 0,
                });
                v.tokens_saved += b.tokens_saved;
                v.dollars_saved += dollars;
                v.events += b.events;
            }

            // Model bucket — only emit when we actually know the
            // (provider, model). Pre-migration-0010 rows + cache hits
            // both write NULL and we'd rather hide them than show a
            // single "unknown / unknown" row that drowns out the real
            // signal.
            if let (Some(prov), Some(model_id)) = (b.provider.as_ref(), b.model.as_ref()) {
                let m = by_model
                    .entry((prov.clone(), model_id.clone()))
                    .or_insert(Acc {
                        tokens_saved: 0,
                        dollars_saved: 0.0,
                        events: 0,
                    });
                m.tokens_saved += b.tokens_saved;
                m.dollars_saved += dollars;
                m.events += b.events;
            }
        }

        // Top contexts: sort by tokens (matches existing UI ordering)
        // and keep top 3.
        let mut top_contexts: Vec<TopContext> = by_context
            .into_iter()
            .map(|(context, acc)| TopContext {
                context,
                tokens_saved: acc.tokens_saved,
                count: acc.events,
                dollars_saved: acc.dollars_saved,
            })
            .collect();
        top_contexts.sort_by(|a, b| b.tokens_saved.cmp(&a.tokens_saved));
        top_contexts.truncate(3);

        // Top ventures by tokens (back-compat shape) + by dollars
        // (new). Two sorts of the same data — cheap, and keeps the
        // existing consumer working unchanged while the new card
        // surfaces the dollar ranking.
        let venture_rows: Vec<(String, Acc)> = by_venture.into_iter().collect();

        let mut top_ventures: Vec<TopVenture> = venture_rows
            .iter()
            .map(|(venture_id, acc)| TopVenture {
                venture_id: venture_id.clone(),
                tokens_saved: acc.tokens_saved,
                events: acc.events,
                dollars_saved: acc.dollars_saved,
            })
            .collect();
        top_ventures.sort_by(|a, b| b.tokens_saved.cmp(&a.tokens_saved));
        top_ventures.truncate(5);

        let mut top_ventures_by_dollars: Vec<TopVentureDollars> = venture_rows
            .into_iter()
            .map(|(venture_id, acc)| TopVentureDollars {
                venture_id,
                dollars_saved: acc.dollars_saved,
                tokens_saved: acc.tokens_saved,
                events: acc.events,
            })
            .collect();
        top_ventures_by_dollars.sort_by(|a, b| {
            b.dollars_saved
                .partial_cmp(&a.dollars_saved)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        top_ventures_by_dollars.truncate(5);

        // Top models by dollars saved.
        let mut top_models_by_dollars: Vec<TopModelDollars> = by_model
            .into_iter()
            .map(|((provider, model), acc)| TopModelDollars {
                provider,
                model,
                dollars_saved: acc.dollars_saved,
                tokens_saved: acc.tokens_saved,
                events: acc.events,
            })
            .collect();
        top_models_by_dollars.sort_by(|a, b| {
            b.dollars_saved
                .partial_cmp(&a.dollars_saved)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        top_models_by_dollars.truncate(3);

        Ok(EventStats {
            lifetime_tokens_saved,
            total_events,
            cache_hit_rate,
            top_contexts,
            top_ventures,
            estimated_dollars_saved_lifetime,
            top_ventures_by_dollars,
            top_models_by_dollars,
        })
    })
}

/// RFC 3339 / ISO 8601 UTC string. Manual format (no chrono dep here
/// either) — mirrors `system_time_to_iso` in lib.rs but takes the
/// current instant. We only need second resolution; the cache doesn't
/// care about microseconds.
fn current_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;

    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let hour = sod / 3600;
    let minute = (sod / 60) % 60;
    let second = sod % 60;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}
