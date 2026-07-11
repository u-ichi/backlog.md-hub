# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Link task cards and list rows directly to Backlog.md `/tasks/:id` deep links now that upstream PR #755 has merged.

## [0.1.0] - 2026-07-09

Initial OSS release.

### Added

- Cross-repo Backlog.md task hub (`scripts/backlog-hub-server.js`) with an embedded HTML UI (board / list view, light / dark theme, mobile drawer, priority stripe, per-repo progress bar).
- Child manager: the hub spawns `backlog browser` per repository, tracks the process group for orphan cleanup on exit, restarts with exponential backoff (1s → 60s), quarantines after 5 consecutive failures within 10s, and reconciles children when the config file changes.
- Config file at `${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub/config.json` with `sources` array accepting `repo` and `base_dir` entries.
- Per-repo port: the hub reads `default_port` directly from each repository's `backlog/config.yml` (no central lockfile).
- macOS LaunchAgent installer (`bin/install-backlog-launchd.sh`) with:
  - Preflight checks (Node.js, Backlog.md CLI, XDG config existence + JSON validity + `sources` schema).
  - Renderable plist template (`launchd/com.github.u-ichi.backlog-md-hub.plist.template`) with `@@REPO_ROOT@@` / `@@HUB_HOST@@` / `@@HOME@@` placeholders.
  - Bind host defaults to `127.0.0.1`; opt in to remote (Tailscale) access with `BACKLOG_HUB_HOST=0.0.0.0`.
  - Verification gate (launchctl print + healthz + repo count) before removing any legacy state.
  - Rollback on gate failure (bootout new label, restore legacy plist, re-bootstrap legacy label).
  - Migration of the author's pre-OSS legacy launchd label (`com.u-kt.backlog-hub`) and old config path (`~/.claude/backlog-hub-config.json` → XDG). No-op on environments without them.
  - `--preflight-only` and `--uninstall` modes.
- Optional Claude Code integration under `integrations/claude-code/` (SessionStart hook that writes the current pane's Backlog.md URL, plus a browser-lib helper). Installed by `./install.sh`.
- English (`README.md`) and Japanese (`README.ja.md`) documentation.
- Node.js standard library only; no npm install step.

[Unreleased]: https://github.com/u-ichi/backlog.md-hub/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/u-ichi/backlog.md-hub/releases/tag/v0.1.0
