# Contributing

Thanks for looking at Backlog.md Hub. This document describes the small set of conventions the project follows so that patches and issues can be triaged quickly.

## Scope

Backlog.md Hub is intentionally a small tool. It aggregates multiple `backlog browser` instances under one URL and supervises them via launchd. It does not try to reimplement Backlog.md itself, add authentication, or become a general-purpose project management server. Feature requests that pull the project in those directions will likely be declined; a fork is often the right answer.

Bug reports, portability fixes, and improvements to the existing scope (config handling, child supervision, installer robustness, UI polish) are welcome.

## Reporting Issues

Please use one of the issue templates. Include:

- macOS version and Node.js version (`node --version`).
- The output of `bin/install-backlog-launchd.sh --preflight-only`.
- Relevant lines from the hub log (`~/Library/Logs/backlog-md/hub.log`).
- Relevant lines from a child browser log (`<repo>/backlog/logs/browser.log` if present).
- A minimal `config.json` that reproduces the problem, with paths anonymized.

## Development

There is no build step and no npm install step. Editing `scripts/backlog-hub-server.js` is enough; the installed LaunchAgent points at the file in your clone directly, so a restart of the LaunchAgent picks up changes.

Restart during development:

```bash
launchctl kickstart -k gui/$(id -u)/com.github.u-ichi.backlog-md-hub
curl -fsS http://127.0.0.1:6419/healthz
```

Static checks:

```bash
shellcheck bin/*.sh install.sh integrations/claude-code/*.sh
node --check scripts/backlog-hub-server.js
plutil -lint launchd/com.github.u-ichi.backlog-md-hub.plist.template
```

If you touch the installer, please add a corresponding manual verification note in your PR description (which preflight cases you ran, what `launchctl print` reported after install, whether rollback triggered).

## Pull Requests

- Keep changes focused. A PR that touches child supervision and adds a new UI feature will be asked to split.
- Preserve backward compatibility for existing users: config file format, env var names, and installed launchd label. Migrations are fine, but do not silently break running installations.
- Update `README.md` and `README.ja.md` when you change user-visible behavior. The two files should stay in sync.
- Add an entry to `CHANGELOG.md` under `[Unreleased]`.
- The commit message convention is `<emoji> <short summary in Japanese or English>` matching the existing history. English-only PRs should use an English summary.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
