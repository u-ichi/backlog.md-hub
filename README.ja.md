# Backlog.md Hub

🇯🇵 日本語版。English README: [README.md](README.md)

## なぜ作ったか

Claude Code や Codex に複数の project を並行で走らせるようになると、同時に立てておきたい `backlog browser` の数がすぐに増えます。project ごとに Backlog.md の state があり、port があり、browser tab があります。「今どの project の誰が何で詰まっているのか」を確認するのに、tab 切り替えで時間が溶けます。project 横断の問い ―「全 project を通して、いま何が In Progress か」― には置き場所がありません。

Backlog.md Hub はその問題だけを解くための小さなローカル daemon です。1 つの config file に repository 一覧を書いておくと、各 repository について `backlog browser` を起動し続け、その横断 task board を 1 つの HTTP URL で提供します。

これは [Backlog.md](https://github.com/MrLesk/Backlog.md) の非公式 companion であり、上流 project の一部ではありません。

## これまでの回避策と、その頭打ち

複数 project で Backlog.md を使っていると、次のような対処に見覚えがあるはずです。どれもある程度までは機能しますが、project 数が増えると必ずどこかで破綻します。

| 回避策 | 頭打ちになるポイント |
| --- | --- |
| project ごとに `backlog browser` を都度起動する | port が衝突し、process が溜まり、bookmark すべき単一 URL が無い |
| project ごとに `launchd` job を並べる | project が増えるたびに plist を書き、port 割当を別途管理する必要がある |
| browser tab を N 個開いておく | project 横断のビューが無く、「今すべてで何が動いているか」を一望できない |
| Backlog.md をやめて hosted tracker に乗り換える | local-first・in-repo・agent と相性が良い、という Backlog.md の性質を捨てることになる |

Backlog.md Hub は「repo ごとに browser を立てる + 1 箇所から見る」という pattern を宣言的に扱えるようにします。config に repository を列挙するだけで、process の面倒と横断ビューは hub 側が引き受けます。

## Requirements

- macOS。同梱 service installer は launchd を使います。
- `PATH` または `/opt/homebrew/bin/node` に Node.js があること。hub は Node.js built-in module だけを使い、npm install step はありません。
- `PATH` に Backlog.md CLI があること。ない場合は `BACKLOG_HUB_CLI_PATH` を設定してください。
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

3. コピーした config を編集します。`sources` には次の 2 種類の entry を書けます (同じ array に混ぜて書けます):

   - `{ "type": "base_dir", "path": "~/projects" }` — 親ディレクトリを走査し、Backlog.md 初期化済みの subdirectory を一括で拾います。`projects/` 配下をまとめて対象にしたい時に 1 行で済みます。
   - `{ "type": "repo", "path": "~/agent" }` — 特定の repository を path で 1 つずつ追加します。`base_dir` の外に置いてある repo (例: home root にある agent 統率用の workspace) を pinpoint で追加したい時に使います。

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
- `BACKLOG_HUB_TAILSCALE_LISTEN`: `true` にすると現在の Tailscale IPv4 address に listener を追加します。既定値は `false`。
- `BACKLOG_HUB_CONFIG`: 明示的な config file path。既定値は上記 XDG config path。
- `BACKLOG_HUB_CLI_PATH`: `backlog` CLI が `PATH` にない場合の絶対パス。
- `BACKLOG_HUB_MANAGE_BROWSERS`: `1` にすると hub が `backlog browser` child process を起動・監視します。
- `XDG_CONFIG_HOME`: `backlog-md-hub/config.json` の base directory。

## Remote Access

hub は認証なしの local UI を提供するため、既定では `127.0.0.1` に bind します。localhost access を維持したまま Tailscale 経由の access を追加する場合は、install 時に明示的に opt-in してください。

```bash
BACKLOG_HUB_TAILSCALE_LISTEN=true bin/install-backlog-launchd.sh
```

hub は OS の network interface から Tailscale IPv4 address を解決します。同じ interface に Tailscale ULA IPv6 prefix があることも確認し、追加 listener を LAN address や `0.0.0.0` へ bind しません。Tailscale が未準備でも localhost は利用でき、追加 listener だけを backoff 付きで再試行します。installer を再実行した時は、環境変数を再指定しない限り既存の flag 値を引き継ぎます。

信頼できない network へ port を公開しないでください。Tailscale access には Tailscale ACL が引き続き適用されますが、hub 自体は認証を追加しません。

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

## 位置付け

Backlog.md Hub の scope は、「作業卓としての task 集約」側です。既存の Backlog.md `backlog browser` を 1 つの view に集約して、agent (と、それを回す人間) が全 project の状況を単一 URL で見られるようにします。

一方、agent が生成した成果物をレビューしたり社外を含めて共有したりする側は、この project の scope ではありません。そちら側は、session 限定の一時プレビューと HTML 内コメントを扱う [reviewable-html-workbench](https://github.com/u-ichi/reviewable-html-workbench)、そしてドメイン限定の恒久共有 URL を扱う `publicar` を別途使っています。これらは Backlog.md Hub の隣に並ぶ tool であって、上に重ねるものではありません。

上流の [Backlog.md](https://github.com/MrLesk/Backlog.md) 本体は、CLI、on-disk task 形式、project ごとの browser の管理元です。hub はそれを wrap しているだけです。

## Uninstall

LaunchAgent を削除します。

```bash
bin/install-backlog-launchd.sh --uninstall
```

この command は生成済み LaunchAgent plist を削除します。config file や Backlog.md repository は削除しません。

## License

MIT。詳細は [LICENSE](LICENSE) を参照してください。
