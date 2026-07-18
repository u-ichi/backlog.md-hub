---
id: TASK-7
title: LaunchAgent の CLI 解決失敗で全 repo browser が停止する問題を修正
status: Done
assignee: []
created_date: '2026-07-18 10:41'
updated_date: '2026-07-18 11:08'
labels:
  - backlog-hub
  - bug
  - launchd
dependencies: []
modified_files:
  - bin/install-backlog-launchd.sh
  - launchd/com.github.u-ichi.backlog-md-hub.plist.template
  - scripts/backlog-hub-server.js
  - tests/child-manager.test.js
  - tests/install-backlog-launchd.test.sh
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Hub は起動しているが、各リポジトリの Backlog.md browser が起動しない障害を修正する。

## 決定事項
- installer が検出した backlog CLI の絶対 path を LaunchAgent の BACKLOG_HUB_CLI_PATH として保存する。
- child process の spawn error では管理状態を片付け、既存 backoff を使って再起動を予約する。
- live LaunchAgent の再配置・再起動は standalone 検証後の独立承認対象とする。

## 見積
agent 実行: 1 session、実装と standalone 検証 30〜60 分、live 検証 10〜20 分
人間側関与: task 作成承認 1 回済み、LaunchAgent 再配置承認 1 回、各 1〜3 分
不確実性: upstream CLI の起動時間や launchd 切替失敗時は切り分け往復が 1 回増える
カレンダー期間: 人間 review 1 回の可用性に依存し、承認後は同日完了見込み
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 installer が解決した backlog CLI の絶対 path が生成 plist の BACKLOG_HUB_CLI_PATH に保存されることをテストで確認する
- [x] #2 spawn error 後に child 管理状態が残留せず backoff 再起動されることをテストで確認する
- [x] #3 node --test tests/*.test.js と tests/install-backlog-launchd.test.sh が成功する
- [x] #4 live 再配置後に /api/tasks が列挙する全 repo の browser port が HTTP 応答する
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
- [x] installer の CLI path 配布について失敗テストを追加する
- [x] spawn error 再試行について失敗テストを追加する
- [x] 両テストの Red を確認する
- [x] plist template / installer と child manager を最小修正する
- [x] standalone test suite を実行する
- [x] live 再配置の承認後、同一観測点で復旧を確認する
- [x] AC / DoD / Notes を更新して Done 判定する
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
検討経緯: 2026-07-18 の live 調査で 6419 は応答する一方、6420〜6429 は全て listener 不在だった。hub.log では全 10 repo が spawn backlog ENOENT。backlog 実体は ~/.local/bin/backlog、LaunchAgent PATH は /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin で再現した。installer は BACKLOG_CLI_BIN を解決するが plist に渡しておらず、server の error handler も再試行を予約しないため、CLI path 配布と spawn error 復旧の両方を修正対象とした。

TDD Cycle:
- Red: child-manager test は ENOENT が1回だけで4秒後に失敗。installer test は生成plistに BACKLOG_HUB_CLI_PATH がなく失敗。
- Cause: installer の BACKLOG_CLI_BIN がrender_plistへ接続されず、child error eventもhandleChildExitへ接続されていなかった。
- Green: templateへBACKLOG_HUB_CLI_PATHを追加し、解決済みpathをrender。error eventを既存backoff経路へ接続し、二重処理をguard。
- Depth: 任意のCLI path・port・spawn ENOENTで成立するため入力固定の症状patchではない。
- Verification: node --test tests/*.test.js は12 pass、shell test成功、node --check・bash -n・git diff --check成功。node --test tests はNode 26でdirectoryをmodule扱いするためACを実行可能なglobへ訂正。preflight-onlyで ~/.local/bin/backlog の解決とconfig検証も成功。

System-integrated verification:
- 承認後に bin/install-backlog-launchd.sh を実行し、rollback付き切替がexit 0。localhost/Tailscaleのhealthz成功、repo count 10。
- 配置先plistをread-backし BACKLOG_HUB_CLI_PATH=~/.local/bin/backlog を確認。
- /api/tasks が列挙した10 repoについて 127.0.0.1 と 100.92.198.57 の各portへ計20 HTTP requestを実行し、20/20がstatus 200。
- lsofで6420〜6429の全10 listenerを確認。hub.logで全10 childに実PIDが付き、新規ENOENTなし。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
LaunchAgentへ解決済みbacklog CLI絶対pathを配布し、spawn errorを既存backoff再起動へ接続した。回帰テストはNode 12/12とinstaller shell testが成功。live installer切替後、10 repoのlocalhost/Tailscale計20 HTTP確認が全て200、6420〜6429の全listenerと配置先plistのCLI pathをread-backした。
<!-- SECTION:FINAL_SUMMARY:END -->
