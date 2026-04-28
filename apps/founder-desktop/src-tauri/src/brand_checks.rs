//! Brand-tab availability probes.
//!
//! Three Tauri commands backing the naming-scan workflow:
//!   - `check_domain`        — DNS + HTTP probe, returns a best-effort
//!                             availability verdict
//!   - `check_social_handle` — hits the public profile URL, parses HTTP
//!                             status into an availability verdict
//!   - `open_url`            — launches a URL in the user's default
//!                             browser (used for UK IPO trademark search)
//!
//! Design notes:
//! - These are not authoritative checks. DNS can lag, parking pages can
//!   mimic real sites, Instagram returns 200 on login-wall "not found"
//!   pages. We express uncertainty explicitly via the `restricted` /
//!   `error` verdicts rather than pretending to know.
//! - Timeouts are short (5s) so a slow probe doesn't stall the Brand
//!   tab UI. A 429 from any platform means "back off" — the TS caller
//!   is responsible for staggering parallel checks (500ms between
//!   platforms) to avoid tripping rate limiters.
//! - Network errors surface as `error` with a free-form `detail` string
//!   the UI shows on hover.

use serde::Serialize;
use std::time::Duration;

/// The `status` string is one of:
/// `available | taken | parked | restricted | error | unknown`
/// Mirrors `AvailabilityStatus` in
/// `packages/branding-core/src/naming-candidates.ts` — keep the literal
/// list in sync.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub status: &'static str,
    pub detail: String,
}

impl CheckResult {
    fn available(detail: impl Into<String>) -> Self {
        Self { status: "available", detail: detail.into() }
    }
    fn taken(detail: impl Into<String>) -> Self {
        Self { status: "taken", detail: detail.into() }
    }
    fn parked(detail: impl Into<String>) -> Self {
        Self { status: "parked", detail: detail.into() }
    }
    fn restricted(detail: impl Into<String>) -> Self {
        Self { status: "restricted", detail: detail.into() }
    }
    fn error(detail: impl Into<String>) -> Self {
        Self { status: "error", detail: detail.into() }
    }
}

// ─────────────────────────────────────────────
// Domain check
// ─────────────────────────────────────────────

/// Decide domain availability via DNS + HTTP probe.
///
/// Verdict matrix:
/// - No A/AAAA records AND no SOA record     → `available`
/// - SOA exists but no A/AAAA (WHOIS-only)   → `taken` (registered but parked)
/// - A/AAAA exists, HTTP reaches a page that mentions "for sale" /
///   "domain parking" keywords                → `parked`
/// - A/AAAA exists, HTTP 200 anything else    → `taken`
/// - A/AAAA exists, HTTP unreachable          → `taken` (DNS is enough)
/// - Any unexpected error                     → `error`
///
/// We use `trust-dns-resolver` for DNS because the default Tokio
/// resolver on Windows can cache misses aggressively and make dead
/// domains look live for several seconds after a failed probe.
#[tauri::command]
pub async fn check_domain(domain: String) -> Result<CheckResult, String> {
    let host = normalise_domain(&domain);
    if host.is_empty() || !is_reasonable_hostname(&host) {
        return Ok(CheckResult::error(format!(
            "'{}' isn't a valid hostname",
            domain
        )));
    }

    // Step 1 — DNS resolution.
    use trust_dns_resolver::config::*;
    use trust_dns_resolver::TokioAsyncResolver;
    let resolver = TokioAsyncResolver::tokio(
        ResolverConfig::default(),
        ResolverOpts::default(),
    );

    let lookup = resolver.lookup_ip(&host).await;
    let has_ip = match &lookup {
        Ok(r) => r.iter().next().is_some(),
        Err(_) => false,
    };

    if !has_ip {
        // DNS miss. Check for an SOA — if one exists the domain is
        // registered but has no public web (squatted / parked-only).
        let soa = resolver
            .soa_lookup(&host)
            .await
            .map(|r| r.iter().count() > 0)
            .unwrap_or(false);
        if soa {
            return Ok(CheckResult::taken(
                "Registered — no A/AAAA records (squatted / parked)".to_string(),
            ));
        }
        return Ok(CheckResult::available("No DNS records found".to_string()));
    }

    // Step 2 — HTTP probe. We only care about whether a real page
    // comes back, not the content type. Use GET not HEAD because
    // parking hosts often 405 on HEAD.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::limited(4))
        .user_agent(
            "Mozilla/5.0 (Founder OS brand-check; +https://founder-os.local)",
        )
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://{}/", host);
    let res = client.get(&url).send().await;

    match res {
        Ok(r) => {
            let status = r.status();
            let body = r.text().await.unwrap_or_default();
            let body_lower = body.to_lowercase();
            let parked = [
                "domain is for sale",
                "domain for sale",
                "buy this domain",
                "domain parking",
                "this domain is parked",
                "parked free",
                "sedoparking",
                "dan.com",
                "godaddy.com/en/lander",
            ]
            .iter()
            .any(|needle| body_lower.contains(*needle));
            if parked {
                Ok(CheckResult::parked(format!(
                    "HTTP {} — looks like a parking page",
                    status.as_u16()
                )))
            } else {
                Ok(CheckResult::taken(format!(
                    "HTTP {} — has a live site",
                    status.as_u16()
                )))
            }
        }
        Err(_) => {
            // DNS said yes, HTTP said no. Treat as taken (registered
            // and pointing at something, even if unreachable from here).
            Ok(CheckResult::taken(
                "Resolves but HTTPS didn't respond — still registered".to_string(),
            ))
        }
    }
}

/// Normalise a user-typed domain into the bare host. Strips scheme,
/// trailing slash, leading `www.` (we probe the apex), whitespace.
fn normalise_domain(input: &str) -> String {
    let mut s = input.trim().to_lowercase();
    if let Some(stripped) = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
    {
        s = stripped.to_string();
    }
    if let Some(stripped) = s.strip_prefix("www.") {
        s = stripped.to_string();
    }
    // Drop any path / query / port after the host.
    if let Some(idx) = s.find(|c: char| matches!(c, '/' | '?' | ':' | '#')) {
        s.truncate(idx);
    }
    s
}

/// Very loose hostname sanity check — non-empty, has a dot, only LDH +
/// dots. We're not trying to be a full DNS validator here; just enough
/// to reject obvious typos before we hit the network.
fn is_reasonable_hostname(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 || !s.contains('.') {
        return false;
    }
    for ch in s.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '.') {
            return false;
        }
    }
    // No leading / trailing / consecutive dots.
    if s.starts_with('.') || s.ends_with('.') || s.contains("..") {
        return false;
    }
    true
}

// ─────────────────────────────────────────────
// Social handle check
// ─────────────────────────────────────────────

/// Map a (platform, handle) into the verdict from an HTTP GET.
///
/// 200 + known login-wall content → `restricted` (we can't tell)
/// 200 (other) → `taken`
/// 301/302 → follow once then re-evaluate (reqwest redirect policy)
/// 404 / 410 → `available`
/// 429 → `restricted` (rate-limited)
/// other → `error`
///
/// Some platforms gate on login walls for handles that don't exist (IG
/// in particular). Rather than lying to the founder, we treat those as
/// `restricted` with a detail explaining why and the UI shows a
/// "check manually" nudge.
#[tauri::command]
pub async fn check_social_handle(
    platform: String,
    handle: String,
) -> Result<CheckResult, String> {
    let handle = handle.trim().trim_start_matches('@').to_lowercase();
    if !is_reasonable_handle(&handle) {
        return Ok(CheckResult::error(format!(
            "'{}' isn't a valid handle",
            handle
        )));
    }

    let url = match platform.as_str() {
        "x" => format!("https://x.com/{}", handle),
        "instagram" => format!("https://www.instagram.com/{}/", handle),
        "tiktok" => format!("https://www.tiktok.com/@{}", handle),
        "threads" => format!("https://www.threads.net/@{}", handle),
        "github" => format!("https://github.com/{}", handle),
        "youtube" => format!("https://www.youtube.com/@{}", handle),
        other => {
            return Ok(CheckResult::error(format!("unknown platform '{}'", other)))
        }
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(3))
        // A real-ish UA — some platforms 403 the default reqwest UA.
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
             AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/124.0.0.0 Safari/537.36",
        )
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await;
    match res {
        Ok(r) => {
            let status = r.status();
            let code = status.as_u16();
            match code {
                404 | 410 => Ok(CheckResult::available(format!("HTTP {}", code))),
                429 => Ok(CheckResult::restricted(format!(
                    "HTTP 429 — rate-limited, try again later"
                ))),
                200..=299 => {
                    // Pull up to 32KB to sniff login walls / placeholder
                    // content. Fetching the whole page is wasteful and
                    // a few platforms stream megabytes of JSON.
                    let body = r.text().await.unwrap_or_default();
                    let snippet = body.chars().take(32_768).collect::<String>();
                    let lower = snippet.to_lowercase();
                    let looks_like_miss = match platform.as_str() {
                        "instagram" => {
                            lower.contains("sorry, this page isn't available")
                                || lower.contains("the link you followed may be broken")
                        }
                        "x" => {
                            lower.contains("this account doesn't exist")
                                || lower.contains("account suspended")
                        }
                        "tiktok" => {
                            lower.contains("couldn't find this account")
                                || lower.contains("this account is private")
                        }
                        "github" => {
                            // GitHub 404s cleanly — 200 + this body is
                            // a real account.
                            false
                        }
                        _ => false,
                    };
                    if looks_like_miss {
                        return Ok(CheckResult::available(format!(
                            "HTTP {} — profile page says 'not found'",
                            code
                        )));
                    }
                    // Login-wall / challenge detection. IG redirects to
                    // /accounts/login/ on unauth; TikTok sometimes shows
                    // a captcha. If the URL visibly changed we can't
                    // tell.
                    let login_wall = lower.contains("login")
                        && (lower.contains("<form")
                            || lower.contains("sign in")
                            || lower.contains("accounts/login"));
                    if login_wall
                        && (platform == "instagram" || platform == "threads")
                    {
                        return Ok(CheckResult::restricted(format!(
                            "HTTP {} — login wall, check manually",
                            code
                        )));
                    }
                    Ok(CheckResult::taken(format!(
                        "HTTP {} — handle is in use",
                        code
                    )))
                }
                403 => Ok(CheckResult::restricted(format!(
                    "HTTP 403 — platform blocked the probe, check manually"
                ))),
                500..=599 => Ok(CheckResult::error(format!(
                    "HTTP {} — platform error",
                    code
                ))),
                _ => Ok(CheckResult::error(format!(
                    "HTTP {} — unexpected response",
                    code
                ))),
            }
        }
        Err(err) => Ok(CheckResult::error(format!("network error: {}", err))),
    }
}

/// Handles are 1-30 chars, ASCII alnum + dot / underscore / dash. We're
/// loose on purpose — each platform has its own rules and we'd rather
/// let the platform tell us "invalid" via a 404 than pre-block a query.
fn is_reasonable_handle(s: &str) -> bool {
    if s.is_empty() || s.len() > 30 {
        return false;
    }
    for ch in s.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-') {
            return false;
        }
    }
    true
}

// ─────────────────────────────────────────────
// URL launcher
// ─────────────────────────────────────────────

/// Launch a URL in the user's default browser. Distinct command from
/// `open_path` so the UI intent is explicit (a URL is not a filesystem
/// path) and the safety posture is clearer for future readers.
///
/// Used for the UK IPO trademark search launcher — the IPO search is
/// an HTML form with no public API, so we open the URL instead of
/// trying to scrape it.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    // Loose scheme check — reject file:// and javascript: and anything
    // that isn't http(s).
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(format!("refusing to open non-http URL: {}", trimmed));
    }

    #[cfg(target_os = "windows")]
    let result = {
        // `cmd /C start "" <url>` — empty title avoids the quirk where
        // `start` treats the first quoted arg as the window title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
    };

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(trimmed).spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(trimmed).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}
