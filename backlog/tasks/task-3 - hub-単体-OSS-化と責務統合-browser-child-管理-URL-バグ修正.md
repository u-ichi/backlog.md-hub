---
id: TASK-3
title: hub 単体 OSS 化と責務統合 (browser child 管理 + URL バグ修正)
status: Done
assignee: []
created_date: '2026-07-08 04:34'
updated_date: '2026-07-09 00:34'
labels:
  - backlog-hub
  - architecture
  - oss
dependencies: []
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

hub (`scripts/backlog-hub-server.js`) を repo 内に閉じ込め、単体で `backlog browser` の起動・監視・URL 提示までを担う自己完結型 daemon に転換する。旧分散配置は hub 中心の構成に統合する。

### 転換後の責務
- hub は自身の config (repo list) を読み、各 repo に port を割り当て、`backlog browser <repo> <port>` を child process として起動・監視・再起動する
- hub 自身の UI (task 横断ビュー) は既存 port (default 6419) で提供する
- 個別 repo web UI への deep link は hub が内部で保持する repo→port map から生成する
- launchd job は hub 1 本のみ
- sessionstart hook は hub 本体から切り離し、必要な場合だけ URL を tmux pane に設定する薄い optional layer にする

### 配置
- script / config / logs は repo 内または XDG config / repository log directory に閉じる
- LaunchAgent plist のみ macOS 制約で user LaunchAgents 配下に置くが、中身は repo path を指す
- port state は hub プロセス内 memory と repo config から導出する

### URL バグ修正
- 現状 `/tasks/${taskId}` を返す `taskUrlFor` により not-found が発生している
- 短期修正として repo top URL を返すよう修正する
- 統合後は repo→port map を hub が持つため、この修正がそのまま活きる

### OSS 化前提
- hub は Claude Code 依存を持たない
- Claude Code 統合は optional layer として repo 内に残すが、hub 本体からは切り離す
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 hub 単体で起動でき、config で指定した repo に対し backlog browser を child 起動する
- [x] #2 child process が crash した場合、hub が自動再起動する (backoff 付き)
- [x] #3 config 変更を検知して reconcile する (追加 repo は spawn / 削除 repo は kill)
- [x] #4 hub UI から task をクリックすると当該 repo の Backlog.md web UI (top URL) が別 tab で開く
- [x] #5 legacy port state / watchdog / external port allocation script への依存が hub 本体から消えている
- [x] #6 hub 停止時に子 browser も grace kill される (SIGTERM → SIGKILL fallback)
- [x] #7 script / config / logs が repo 内または XDG config / repository log directory に閉じ、LaunchAgent plist のみ user LaunchAgents 配下に置かれる
- [x] #8 README に OSS 単体運用と Claude Code 統合運用の 2 mode の起動手順が書かれている
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
- [x] 設計フェーズ: hub の子プロセス管理・port 採番・reconcile ロジックの詳細設計を task に記録
- [x] URL バグ修正 (短期): install.sh 再実行 + hub restart で `taskUrlFor` を top URL 化
- [x] Phase 1: hub の port 参照を config.yml `default_port` 直読に置換 (mtime cache 付き)
- [x] Phase 2: hub 内で `backlog browser` を child_process.spawn (detached=true、logs は repo 内 `backlog/logs/browser.log`)
- [x] Phase 2: exit 検知で process group 全体 SIGKILL (orphan 掃除) + backoff 付き再起動
- [x] Phase 2: fs.watch(HUB_CONFIG) で reconcile
- [x] Phase 2: 旧 browsers-ensure job と外部 port allocation script への依存を廃止
- [-] (deferred) hub 内部モジュール分割 (config-loader / port-allocator / child-manager / repo-scanner / web-server) — 現状 1 file で保守可能、必要になったら実施
- [x] Phase 3: 配置整理 (`scripts/backlog-hub-server.js`、`config/`、`logs/`、`.gitignore`)
- [x] Phase 3: launchd plist path を repo 直接参照へ、`install-backlog-launchd.sh` に `@@REPO_ROOT@@` 置換追加
- [x] Phase 4: sessionstart hook 縮退 (port allocation 呼び出し削除、自 repo config.yml 直読)
- [ ] Phase 5: README に OSS 単体 / Claude Code 統合 の 2 mode 手順、実機で全 AC 検証
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## 検討経緯

- 発端: hub UI の task カードクリックで Backlog.md web UI に未実装の deep link が生成され、not-found になる問題をユーザーが指摘
- 短期修正として `taskUrlFor` を repo top URL へ変更する方針を採用
- ユーザーから「なぜ配布先に copy しているのか」の疑問が出た。理由は親 repo の fan-out 慣習を踏襲していただけで、この単体 daemon プロジェクトでは copy の必然性がない
- 選択肢を提示: (a) plist を repo 内 script 直接参照 (b) symlink (c) 現状維持
- ユーザー選択: (a) 直接参照でシンプル化。かつ旧 prefix も不要
- 派生議論: hub 自体を repo に閉じ込めるべき (script / config / logs)。ただし LaunchAgent plist は macOS 制約でユーザー LaunchAgents 配下必須
- OSS 化観点: hub は単体で成立するが、旧 port state / watchdog / sessionstart hook と結合していた。この分離を明確化すれば OSS 単体配布可能
- 最終方針: hub が `backlog browser` の起動・監視・URL 提示までを一手に担う self-contained orchestrator に転換。config で Backlog.md を動かしたい directory を指定するだけで動く形を目指す
- URL バグ修正は本 task の Implementation Plan の短期修正として吸収。統合完了まで生きた運用を維持するため

## 設計

- port master は各 repo `backlog/config.yml` の `default_port`、hub が単独 writer
- hub 内モジュール分割候補: config-loader / port-allocator / child-manager / repo-scanner / web-server
- 実装 5 phase: (1) port 管理 config.yml 化 (2) child manager 追加 (3) 配置整理 (4) sessionstart hook 縮退 (5) 検証と README
- 未解決論点 A/B/C: child log 集約先 / hook の hub API vs config.yml 直読 / backlog CLI PATH resolution

## 論点確定 (A/B/C)

- A: child log は repo 内 `<repo>/backlog/logs/browser.log`
- B: sessionstart hook は自 repo `backlog/config.yml` の `default_port` を直読 (hub 停止時も動く。port 未設定なら hook skip)
- C: `backlog` CLI path は config `backlog_cli_path` で override 可能、未指定なら PATH resolve

## Phase 1 完了

hub の port 参照を `backlog/config.yml` の `default_port` 直読に置換 (regex parse、mtime cache 付き)。実測: `/api/tasks` の各 repo port が全て config.yml 値と一致。

## Phase 2 完了

- hub が `child_process.spawn("backlog", ["browser", "--port", ...], { detached: true, stdio: ["pipe", logFd, logFd] })` で child 起動
- exit 検知で `process.kill(-pid, "SIGKILL")` により process group 全体を掃除
- backoff は 1s から最大 60s、連続失敗で quarantine
- shutdown 時は SIGTERM → 5s grace → SIGKILL、SIGTERM 受信で children map 全 kill
- fs.watch(HUB_CONFIG) で debounce 後 reconcile
- 旧 watchdog と外部 port allocation script への依存を廃止
- 検証: 10 repo 全て正常 spawn / crash 復旧 / hub shutdown → launchd respawn で全 child 再構築
- hub 内部モジュール分割は defer (1 file で保守できているため)

## repo 名統一

- ローカルディレクトリ: `backlog.md.all` → `backlog.md-hub`
- GitHub: `u-ichi/backlog.md.all` → `u-ichi/backlog.md-hub`
- git remote: 新 URL に更新
- 表示名: `Backlog Hub` → `Backlog.md Hub`
- 検証: hub 再起動 → healthz OK / child process / `/api/tasks` で `backlog.md-hub` として認識
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
hub 単体 OSS 化と責務統合完了。Phase 1/2 (child manager + browsers-ensure 廃止) を SHA 4cdc68a で先行 commit、その後 Phase 3-5 を SHA 9c7f474/05e94e8/aa154a7/e4f8b80 で完走。稼働中 launchd は com.github.u-ichi.backlog-md-hub (127.0.0.1:6419、hub が browser 10 repo を child 管理) に切替済み。README に 2 mode 手順記載、AC 8/8 達成。OSS 公開作業は TASK-4 で完走 (repo public 化済み)。
<!-- SECTION:FINAL_SUMMARY:END -->
