//! OS-keychain-backed secret storage for LLM API keys.
//!
//! Keys used to live in the `api_key` column of SQLite in plaintext. That's
//! fine for a local-first single-user desktop app, but offered zero defence
//! against anything that could read the DB file (another process, a backup
//! scraper, a stray `cat`). These commands move the secret to the OS
//! credential store — Credential Manager on Windows, Keychain on macOS,
//! Secret Service on Linux — and leave SQLite with non-secret config only.
//!
//! Service name `founder-os-llm`, username = provider id (e.g. `openai`).
//! The TS side migrates legacy plaintext rows into the keychain on first read
//! and nulls the DB column. See `db.ts::getLlmSetting`.
use keyring::Entry;

const SERVICE: &str = "founder-os-llm";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("keyring init failed: {}", e))
}

/// Store (or replace) a secret for the given provider.
#[tauri::command]
pub fn keyring_set(provider: String, secret: String) -> Result<(), String> {
    let e = entry(&provider)?;
    e.set_password(&secret)
        .map_err(|err| format!("keyring set failed: {}", err))
}

/// Fetch a secret. Returns `None` if no entry exists for this provider —
/// that's the normal "user hasn't pasted a key yet" case and is not an error.
#[tauri::command]
pub fn keyring_get(provider: String) -> Result<Option<String>, String> {
    let e = entry(&provider)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        // `NoEntry` is the "not found" case on every backend. Everything else
        // (locked keychain, dbus failure, etc.) we surface as an error.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring get failed: {}", err)),
    }
}

/// Delete a secret. No-op (success) if it's already absent — keeps callers
/// from having to special-case "already cleared".
#[tauri::command]
pub fn keyring_delete(provider: String) -> Result<(), String> {
    let e = entry(&provider)?;
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("keyring delete failed: {}", err)),
    }
}
