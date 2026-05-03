# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Vision provider abstraction for `sellbot_book_identify_from_photo` and the
  `sellbot_listing_create_from_inbox` flow. New env `MASTROTA_VISION_PROVIDER`
  selects `ollama` (default, backward compatible) or `openrouter`. The
  OpenRouter backend hits the OpenAI-compatible `/chat/completions` endpoint
  with an `image_url` content part and `response_format: { type: "json_object" }`,
  configured via `MASTROTA_OPENROUTER_API_KEY`, `MASTROTA_OPENROUTER_BASE_URL`,
  `MASTROTA_OPENROUTER_VISION_MODEL` (default `openai/gpt-4o-mini`),
  `MASTROTA_OPENROUTER_VISION_TIMEOUT_MS`, and optional
  `MASTROTA_OPENROUTER_HTTP_REFERER` / `MASTROTA_OPENROUTER_X_TITLE` headers.
  Use case: nodes without a local GPU where Ollama vision exceeds the per-call
  timeout. The MCP tool surface and result schema are unchanged.
- `sellbot_inbox_add_photo` and `sellbot_listing_create_from_inbox` MCP tools
  to support chat clients (e.g. `tg-mcp-bot`) that receive images from
  Telegram. Photos land in `ToSell/_inbox/<session_id>/photos/` without the
  client needing to know a slug; the create-from-inbox tool runs vision on the
  cover, derives a slug from the identified title, renames the folder under
  `ToSell/<slug>/` and runs enrichment. Stale inbox sessions older than 24h
  are purged automatically. Includes `slugifyTitle` helper, MIME validation,
  per-photo size cap (25 MB), and slug collision handling with numeric
  suffixes.

### Fixed

- Include consent URL in plain text in `sellbot_auth_start` MCP tool result so
  LLM clients can quote it directly to the user. The URL is now on its own line
  in `content[0].text`, while `structuredContent.data.consentUrl` is preserved
  for clients reading the JSON payload.
- `sellbot_auth_complete` now surfaces a readable success message plus token
  `expires_at`, `refresh_token_expires_at` and `scope` in `content[0].text`,
  with the same fields exposed under `structuredContent.data.token`.
