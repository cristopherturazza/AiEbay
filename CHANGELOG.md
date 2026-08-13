# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `sellbot_listings_import_remote` MCP tool and `sellbot listings:import-remote`
  CLI command to rebuild `ToSell/` folders from eBay. Recovery path for listings
  that are live on eBay but whose local folder is gone: `sellbot_listing_delete`
  is an unrecoverable `rm -rf` with no trash and no backup, so eBay was the only
  surviving source. For every inventory-backed offer the importer writes
  `draft.json` (title, description, condition, price, `category_id`, aspects →
  `item_specifics`), `status.json` and a `notes.txt` recording provenance, and
  re-downloads photos into `photos/remote-NN.jpg`. Guarantees: it never
  overwrites an existing folder (slug collisions land in `skipped`); folders
  already linked by `listing_id` only get their `ebay.listing_status` snapshot
  refreshed; local unpublished drafts that look like an already-live listing are
  reported in `duplicates` using a slug comparison tolerant of SKU truncation.
  Options: `dry_run`, `active_only` (default false, so `ENDED` and
  `OUT_OF_STOCK` are imported too), `download_photos`, `redownload_photos`,
  `limit`. Not recoverable: `intake.json`, `enrichment.json`, original notes and
  `published_at` — the Inventory API only exposes what was published.
- Optional `ebay.listing_status` and `ebay.listing_status_checked_at` in
  `status.json`, so a local folder can record that its listing is `ENDED` or
  `OUT_OF_STOCK`. Previously `status.state` had no way to express it and a
  folder stayed `published` forever. The snapshot is informational: the source
  of truth remains `sellbot_remote_listings_list`.

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

- `docs/listing-style.md`: binding rules for titles, item specifics and
  categories on `EBAY_IT`, derived from an audit of 17 real listings where 9 of
  the 10 active ones had zero views. Key finding: the item specifics used English
  aspect names (`Author`, `Book Title`, `Publisher`, …) which do not exist on
  `EBAY_IT`, so they were accepted as free-form aspects and powered no search
  filter at all. Also records two project decisions: no Promoted Listings, and
  bundles over cheap singles.

### Fixed

- `EbayMediaClient.uploadImage` retries `createImageFromFile` on 5xx/429 with
  exponential backoff (4 attempts). eBay's Media API fails intermittently with
  `190000` ("eBay internal system or process"): the same file is rejected and
  accepted seconds later, seemingly at random. Uploads are sequential, so a
  single hiccup aborted an entire publish — a 6-photo bundle failed three times
  in a row before the retry was added, then went through on the first try with
  two images visibly retried.
- `sellbot revise` now realigns the remote Best Offer thresholds to the draft
  price ladder (`quick_sale` → `autoAcceptPrice`, `floor` → `autoDeclinePrice`).
  The thresholds live on the remote offer and were computed against the old
  price, so any price cut made them invalid and eBay rejected the whole revise
  with error 25016 ("l'importo per il rifiuto automatico non può essere pari o
  superiore al prezzo Compralo Subito"). Lowering a price was effectively
  impossible on any listing with Best Offer enabled.
- `looksLikeBookDraft` no longer depends on English item specific names. It read
  `item_specifics["Book Title"]`, `.Author`, `.Publisher` and `.ISBN`, which do
  not exist on `EBAY_IT` (see `docs/listing-style.md`): drafts using the correct
  Italian aspect names were not recognised as books and silently lost their
  shipping profile, falling back to the single-book rate. Detection now accepts
  both namings and treats the presence of a book aspect as sufficient, so a
  bundle titled "2 Romanzi storici: …" resolves to `book_heavy` as it should.
- `sellbot revise` now sends the category from the local draft instead of
  keeping the one already on the remote offer. A wrong category was previously
  impossible to correct via revise: one listing sat in category `268` (11
  aspects, no `Titolo`/`Genere`/`Lingua`/`Formato`) instead of `171243`, cut out
  of every filtered search in its section.
- Include consent URL in plain text in `sellbot_auth_start` MCP tool result so
  LLM clients can quote it directly to the user. The URL is now on its own line
  in `content[0].text`, while `structuredContent.data.consentUrl` is preserved
  for clients reading the JSON payload.
- `sellbot_auth_complete` now surfaces a readable success message plus token
  `expires_at`, `refresh_token_expires_at` and `scope` in `content[0].text`,
  with the same fields exposed under `structuredContent.data.token`.
