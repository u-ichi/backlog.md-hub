# Backlog.md Hub

🌐 日本語版 → [README.ja.md](README.ja.md)

Backlog.md Hub is a small local daemon for running and viewing multiple [Backlog.md](https://github.com/MrLesk/Backlog.md) projects from one browser UI.

The hub reads a JSON config, discovers Backlog.md repositories, starts `backlog browser` child processes, and serves a cross-repository task board. It is an unofficial companion for Backlog.md, not part of the upstream project.

## Requirements

- macOS. The included service installer uses launchd.
- Node.js available on `PATH` or at `/opt/homebrew/bin/node`. The hub uses only built-in Node.js modules and has no npm dependency install step.
- Backlog.md CLI available on `PATH`, or set `BACKLOG_HUB_CLI_PATH`.
- One or more repositories initialized with Backlog.md.

## Quick Start

1. Clone the repository:

   ```bash
   git clone https://github.com/u-ichi/backlog.md-hub.git ~/backlog.md-hub
   cd ~/backlog.md-hub
   ```

2. Create a config file:

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub"
   cp ~/backlog.md-hub/config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub/config.json"
   ```

3. Edit the copied config and point `sources` at your Backlog.md repositories.

4. Run preflight:

   ```bash
   bin/install-backlog-launchd.sh --preflight-only
   ```

5. Install and start the LaunchAgent:

   ```bash
   bin/install-backlog-launchd.sh
   ```

6. Open the hub:

   ```text
   http://127.0.0.1:6419/
   ```

## Config Reference

The default config path is:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub/config.json
```

Minimal example:

```json
{
  "sources": [
    { "type": "repo", "path": "~/projects/app" },
    { "type": "base_dir", "path": "~/projects" }
  ]
}
```

`repo` entries point at one repository. `base_dir` entries scan direct child directories and include the ones that contain Backlog.md state.

Supported environment variables:

- `BACKLOG_HUB_PORT`: hub HTTP port. Default: `6419`.
- `BACKLOG_HUB_HOST`: hub bind host. Default: `127.0.0.1`.
- `BACKLOG_HUB_CONFIG`: explicit config file path. Default: the XDG config path above.
- `BACKLOG_HUB_CLI_PATH`: absolute path to the `backlog` CLI when it is not on `PATH`.
- `BACKLOG_HUB_MANAGE_BROWSERS`: set to `1` to let the hub spawn and supervise `backlog browser` child processes.
- `XDG_CONFIG_HOME`: base directory for `backlog-md-hub/config.json`.

## Remote Access

The hub binds to `127.0.0.1` by default because it serves an unauthenticated local UI. To use it over a trusted private network such as Tailscale, opt in at install time:

```bash
BACKLOG_HUB_HOST=0.0.0.0 bin/install-backlog-launchd.sh
```

Only expose the port on networks you trust.

Individual `backlog browser` child processes are spawned by the upstream CLI, and their bind behavior is controlled by the upstream CLI rather than by this hub.

## Claude Code Integration

The hub itself does not require Claude Code. Optional Claude Code integration lives under `integrations/claude-code/` and installs a thin SessionStart hook that sets the current pane's Backlog.md URL when a project has a configured Backlog.md browser port.

Install the optional integration with:

```bash
./install.sh
```

## Architecture

- `scripts/backlog-hub-server.js` serves the hub UI and API.
- The hub reads repository sources from the XDG config file.
- For each repository, the hub starts `backlog browser` as a child process and writes child logs under that repository's Backlog.md log directory.
- Child browser processes are reconciled when config changes, restarted with backoff after crashes, quarantined after repeated failures, and stopped with the hub.
- `launchd/com.github.u-ichi.backlog-md-hub.plist.template` is rendered by `bin/install-backlog-launchd.sh`.
- The installer supports migration from a legacy launchd label (`com.u-kt.backlog-hub`) that the original author used prior to OSS release. On environments without that label the migration path is a no-op.

## Uninstall

Remove the LaunchAgent:

```bash
bin/install-backlog-launchd.sh --uninstall
```

The command removes the generated LaunchAgent plist. It does not remove your config file or Backlog.md repositories.

## License

MIT. See [LICENSE](LICENSE).
