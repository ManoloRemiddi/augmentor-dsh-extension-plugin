<!--
  Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
  Copyright © 2026 Manolo Remiddi
  SPDX-License-Identifier: MIT
  License: MIT — see LICENSE at the repository root.
-->

# Changelog

All notable changes to Augmentor (the `dsh-augmentor` plugin + the Chromium
extension). Versions are locked across `plugin/package.json` and
`extension/manifest.json`.

## 0.1.29 — 2026-09-01

### Added

- **DSH session-tab protection** — the agent never works in the tab that hosts
  the user's own DSH web session (the session it is talking through):
  `browser_navigate` opens a dedicated tab instead of navigating it away, read
  actions fail with a directive error, `browser_tabs_list` marks the tab with
  `[DSH session]` (`dsh: true`), and a sticky work tab the user navigates onto
  the DSH GUI loses its stickiness. Origin matching treats `localhost` and
  `127.0.0.1` as the same loopback server and rejects lookalikes
  (port `30800`, `3080.evil.example`, other ports, https-vs-http).
- **Model picker Refresh** (side panel) — a Refresh footer in the model
  popover forces a fresh catalog fetch from the running DSH app (live
  `settings.yaml` read via the bridge, no restart): a model added while the
  panel is open now appears; if the current selection fell out of the catalog
  it falls back to the catalog default (the same rule the handshake applies).

### Tests

- New hermetic suite `test/dsh-tab-test.mjs` (13 scenarios: sticky-tab
  survival, fallback exclusion, origin matching, dedicated-tab navigate,
  directive errors, `tabs_list` marking) — run with
  `node test/dsh-tab-test.mjs`.

## 0.1.27 — 2026-08-28

### Fixed

- Packaged dist: runtime deps (`ws`, `@deepseek-ai/dsh-tools`,
  `@deepseek-ai/schemastery`) externalized — the npm install resolves them from
  the profile's `node_modules` instead of inlining them.
- F8 audit: plugin-WS liveness heartbeat kills the zombie-pipe mode; the
  heartbeat also counts handshake pipes (F8b).
- Installer: `mkdir -p bin/` before writing the launcher (fresh clones), and
  the repo-root pipe dependencies are installed on first run in a fresh clone.
- Deterministic fresh-user install proof (`test/install-proof.mjs`) + the
  `install-proof` CI workflow on every push/PR.

## 0.1.26 — 2026-08-28

- Initial public npm release of `dsh-augmentor`.
