# Backlog.md Hub

🇯🇵 日本語版。English README: [README.md](README.md)

Backlog.md Hub は、複数の [Backlog.md](https://github.com/MrLesk/Backlog.md) プロジェクトを 1 つの browser UI で扱うためのローカル daemon です。

hub は JSON config を読み、Backlog.md repository を検出し、`backlog browser` の child process を起動して、横断 task board を提供します。これは Backlog.md の非公式 companion であり、上流 project の一部ではありません。

## Requirements

- macOS。同梱 service installer は launchd を使います。
- `PATH` または `/opt/homebrew/bin/node` に Node.js があること。hub は Node.js built-in module だけを使い、npm dependency install step はありません。
- `PATH` に Backlog.md CLI があること。ない場合は `BACKLOG_HUB_CLI_PATH` を設定すること。
- Backlog.md 初期化済み repository が 1 つ以上あること。

## Quick Start

1. repository を clone します。

   ```bash
   git clone https://github.com/u-ichi/backlog.md-hub.git ~/backlog.md-hub
   cd ~/backlog.md-hub
   ```

2. config file を作成します。

   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub"
   cp ~/backlog.md-hub/config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub/config.json"
   ```

3. コピーした config の `sources` を自分の Backlog.md repository に合わせて編集します。

4. preflight を実行します。

   ```bash
   bin/install-backlog-launchd.sh --preflight-only
   ```

5. LaunchAgent を配置して起動します。

   ```bash
   bin/install-backlog-launchd.sh
   ```

6. hub を開きます。

   ```text
   http://127.0.0.1:6419/
   ```

## Config Reference

既定の config path は次の通りです。

```text
${XDG_CONFIG_HOME:-$HOME/.config}/backlog-md-hub/config.json
```

最小例:

```json
{
  "sources": [
    { "type": "repo", "path": "~/projects/app" },
    { "type": "base_dir", "path": "~/projects" }
  ]
}
```

`repo` は単一 repository を指します。`base_dir` は直下の child directory を走査し、Backlog.md state を持つものを対象にします。

対応する環境変数:

- `BACKLOG_HUB_PORT`: hub HTTP port。既定値は `6419`。
- `BACKLOG_HUB_HOST`: hub bind host。既定値は `127.0.0.1`。
- `BACKLOG_HUB_CONFIG`: 明示的な config file path。既定値は上記 XDG config path。
- `BACKLOG_HUB_CLI_PATH`: `backlog` CLI が `PATH` にない場合の絶対パス。
- `BACKLOG_HUB_MANAGE_BROWSERS`: `1` にすると hub が `backlog browser` child process を起動・監視します。
- `XDG_CONFIG_HOME`: `backlog-md-hub/config.json` の base directory。

## Remote Access

hub は認証なしの local UI を提供するため、既定では `127.0.0.1` に bind します。Tailscale など信頼できる private network 越しに使う場合だけ、install 時に明示的に opt-in してください。

```bash
BACKLOG_HUB_HOST=0.0.0.0 bin/install-backlog-launchd.sh
```

信頼できない network へ port を公開しないでください。

個別の `backlog browser` child process は upstream CLI が起動するため、その bind 挙動はこの hub ではなく upstream CLI 側の制御に従います。

## Claude Code Integration

hub 本体は Claude Code を必要としません。任意の Claude Code integration は `integrations/claude-code/` 配下にあり、project に Backlog.md browser port が設定されている時だけ、現在の pane に Backlog.md URL を設定する薄い SessionStart hook を配置します。

任意 integration は次で配置できます。

```bash
./install.sh
```

## Architecture

- `scripts/backlog-hub-server.js` が hub UI と API を提供します。
- hub は XDG config file から repository source を読みます。
- 各 repository について、hub は `backlog browser` を child process として起動し、child log をその repository の Backlog.md log directory に書きます。
- child browser process は config 変更時に reconcile され、crash 後は backoff 付きで再起動され、連続失敗時は quarantine され、hub 停止時に一緒に停止されます。
- `launchd/com.github.u-ichi.backlog-md-hub.plist.template` は `bin/install-backlog-launchd.sh` が render します。
- installer は OSS 公開前に original author が使っていた legacy launchd label (`com.u-kt.backlog-hub`) からの migration をサポートします。その label が存在しない環境では migration path は何もせず終了します。

## Uninstall

LaunchAgent を削除します。

```bash
bin/install-backlog-launchd.sh --uninstall
```

この command は生成済み LaunchAgent plist を削除します。config file や Backlog.md repository は削除しません。

## License

MIT。詳細は [LICENSE](LICENSE) を参照してください。
