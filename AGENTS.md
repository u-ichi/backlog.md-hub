# Backlog.md Hub プロジェクト指示

この repo は Backlog.md browser / watchdog / hub の実装を管理する独立 repo。

## 目的

- `agent` repo と `projects/*` 配下の Backlog.md 対象を横断して扱う。
- Claude SessionStart hook、watchdog、hub server、launchd plist、installer をここで管理する。
- 旧 `agent` repo 側の `home/skills/backlog-md/SKILL.md` は Backlog.md CLI skill として残す。

## 境界

- この repo の `scripts/` は hub server 本体、`launchd/` は plist template、`integrations/claude-code/` は optional Claude Code hook/lib、`bin/` は installer を管理する。
- `agent` repo の `install.sh` や Claude/Codex 共通設定はこの repo では直接管理しない。
- 計画と異なる phase の変更を混ぜない。

## 実装規約

- 日本語で応答する。
- 既存 shell / Node.js のスタイルに合わせ、要求範囲に変更を絞る。
- git 管理ファイルにマシン固有の絶対パスを書かない。
- 配布先パスを書く必要がある場合は `~`、`@@HOME@@`、実行時導出を使う。
- 検証可能な変更は自分で検証してから完了報告する。
- launchd やユーザー環境の shared state を変える操作は、明示承認後に実行する。
- Backlog.md task は `backlog` CLI 経由で操作し、task ファイルを直接編集しない。
