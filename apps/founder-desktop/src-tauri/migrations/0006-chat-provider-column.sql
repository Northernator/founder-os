-- 0006 — record which provider generated each assistant message
--
-- Lets the chat bubble render a small "via Claude" / "via ChatGPT" / "via
-- Gemini" caption so the user can see which LLM answered them. Also
-- useful for future usage-counting, debugging model-specific regressions,
-- and distinguishing API-key vs subscription-CLI transports.
--
-- Nullable because (a) existing rows pre-0006 have no provider, and (b)
-- user-role messages don't have one — only assistants do. Renderer skips
-- the caption when this is NULL so legacy history looks unchanged.
--
-- `provider_mode` is the transport: 'api_key' | 'subscription'. Lets the
-- UI distinguish "Claude via API" from "Claude via your Pro subscription"
-- without joining to llm_settings (which may have shifted since the
-- message was sent).
ALTER TABLE chat_messages ADD COLUMN provider TEXT;
ALTER TABLE chat_messages ADD COLUMN provider_mode TEXT;
