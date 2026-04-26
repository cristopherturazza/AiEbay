# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Include consent URL in plain text in `sellbot_auth_start` MCP tool result so
  LLM clients can quote it directly to the user. The URL is now on its own line
  in `content[0].text`, while `structuredContent.data.consentUrl` is preserved
  for clients reading the JSON payload.
- `sellbot_auth_complete` now surfaces a readable success message plus token
  `expires_at`, `refresh_token_expires_at` and `scope` in `content[0].text`,
  with the same fields exposed under `structuredContent.data.token`.
