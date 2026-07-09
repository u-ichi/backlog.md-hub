# Backlog.md Hub

🌐 日本語版 → [README.ja.md](README.ja.md)

## Why this exists

Once you let Claude Code or Codex drive work across several projects at once, the number of `backlog browser` instances you need running at the same time goes up fast. Each project has its own Backlog.md state, its own port, and its own browser tab. Switching between them to answer "who's blocked on what" turns into tab-hunting, and cross-project questions ("what's actually in progress right now, across everything?") have no place to land.

Backlog.md Hub is a small local daemon that solves that specific problem. It reads one config file listing your repositories, keeps a `backlog browser` running for each one, and serves a single cross-repo task board over HTTP.

It is an unofficial companion for [Backlog.md](https://github.com/MrLesk/Backlog.md), not part of the upstream project.

## What people were doing before

If you have been running Backlog.md across many projects, the workarounds probably look familiar. Each of them works up to a point.

| Workaround | Where it breaks down |
| --- | --- |
| Start `backlog browser` per project as needed | Ports collide, processes accumulate, and there is no single URL to bookmark |
| One `launchd` job per project | Every new project means a new plist; port allocation has to be tracked out of band |
| Keep N browser tabs open | No cross-project view; hard to see "everything in progress right now" |
| Skip Backlog.md and use a hosted tracker | Loses the local-first, in-repo, agent-friendly properties of Backlog.md |

Backlog.md Hub takes the "one browser per repo, surfaced from one place" pattern and makes it declarative: you list the repositories in a config file, and the hub takes care of the process lifecycle and the aggregated view.

## Requirements

- macOS. The included service installer uses launchd.
- Node.js available on `PATH` or at `/opt/homebrew/bin/node`. The hub uses only built-in Node.js modules and has no npm install step.
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

3. Edit the copied config. `sources` accepts two kinds of entries, which you can mix in the same array:

   - `{ "type": "base_dir", "path": "~/projects" }` — scan a parent directory and pick up every subdirectory that has Backlog.md initialized. Point this at your `projects/` directory to include everything under it in one line.
   - `{ "type": "repo", "path": "~/agent" }` — add one specific repository by path. Use this for a repo that lives outside your `base_dir`, for example an agent-orchestration workspace at your home root.

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

The hub itself does not require Claude Code. An optional integration lives under `integrations/claude-code/` and installs a thin SessionStart hook that sets the current pane's Backlog.md URL when a project has a configured Backlog.md browser port.

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

## Where it fits

Backlog.md Hub is scoped to the engineer's task cockpit side of the workflow. It aggregates existing Backlog.md `backlog browser` instances into one view, so an agent (or the human running one) can see what is in progress across every project at a single URL.

Reviewing and sharing agent-generated artifacts is a separate concern that this project does not try to cover. For that side of the workflow, I use [reviewable-html-workbench](https://github.com/u-ichi/reviewable-html-workbench) for session-scoped previews with in-HTML comments, and `publicar` for domain-restricted permanent share URLs. Those tools sit next to Backlog.md Hub, not on top of it.

Upstream [Backlog.md](https://github.com/MrLesk/Backlog.md) itself remains the source of truth for the CLI, the on-disk task format, and the per-project browser. The hub only wraps that.

## Uninstall

Remove the LaunchAgent:

```bash
bin/install-backlog-launchd.sh --uninstall
```

The command removes the generated LaunchAgent plist. It does not remove your config file or Backlog.md repositories.

## License

MIT. See [LICENSE](LICENSE).
