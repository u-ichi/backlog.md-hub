---
id: TASK-2
title: agent install との配布衝突を解消し chain install 化する
status: Done
assignee: []
created_date: '2026-07-07 04:50'
updated_date: '2026-07-10 01:51'
labels:
  - install
  - hook
  - launchd
  - backlog-hub
dependencies: []
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

agent repo 側 installer が Backlog.md Hub 管理 file を cleanup する配布衝突を、以下 2 点で解消する:

1. agent repo 側 installer の cleanup 対象から Backlog.md Hub 管理 file を除去する
2. agent repo 側 installer 末尾に Backlog.md Hub installer の chain 呼び出しを追加する。存在チェック付き、失敗時は warn skip、post-chain で必要 file の存在確認 loop を実行する

Backlog.md Hub installer は standalone 実行を維持する。関連 hook の shellcheck 指摘修正と、診断用 logging 追加も同 commit に含める。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 agent/install.sh から backlog 系 5 file の cleanup entry が消えている
- [x] #2 agent/install.sh 末尾で projects/backlog.md.all/install.sh を chain 呼び出しし、失敗時は warn で継続する
- [x] #3 chain 直後に 5 file 存在確認 loop があり、欠落時は warn を出す
- [x] #4 hook の SC1010 が解消され shellcheck が通る (bbh_log "done")
- [x] #5 backlog.md.all/install.sh 単独実行でも従来通り配布が完結する
- [x] #6 backlog.md.all/install.sh 実行後、~/.claude/scripts/ に 5 file が復元されている
- [x] #7 launchctl print で hub / browsers 両 service が登録済みかつ稼働状態である
- [x] #8 curl http://localhost:6419/healthz が ok を返す
- [x] #9 lead pane から hook 手動発火で backlog-browser-hook-*.log に tag=done が記録される
- [x] #10 hook 手動発火後、対象 pane の @ai_backlog_url が set されている
- [x] #11 agent/install.sh 通し実行後に ~/.claude/scripts/ の 5 file が残存し、chain ok ログが出ている
- [x] #12 bash -n / shellcheck が両 install.sh + hook 本体 3 file 全通過
- [x] #13 bin/lint-absolute-paths.sh が agent repo で通過
- [x] #14 agent repo commit に install.sh 以外の 3 file (docs/architecture.md 他) が含まれていない
- [x] #15 backlog.md.all commit に hook logging + SC1010 修正 + README 追記が含まれる
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Phase 1: agent/install.sh 修正 (cleanup から 5 file 除去 + chain 呼び出し + post-chain 存在確認)
2. Phase 2-1: README.md に配布構造 (chain 実行 / standalone 両立) を追記
3. Phase 2-2: hook SC1010 修正 (bbh_log "done")
4. Phase 2-3: /commit skill 経由で hook + README 差分を commit (backlog.md.all repo)
5. Phase 3-1: backlog.md.all/install.sh 実行し ~/.claude/scripts/ の 5 file 復元を ls で実測
6. Phase 3-2: launchctl print で hub/browsers 登録状態を切り分け (未登録なら bin/install-backlog-launchd.sh 再実行)
7. Phase 3-3: curl http://localhost:6419/healthz + watchdog ensure log 確認
8. Phase 3-4: lead pane (%35) から hook 手動発火 → tag=done + @ai_backlog_url 実測
9. Phase 4-1: agent/install.sh 通し実行 → 5 file 残存 + chain ok ログを実測
10. Phase 4-2: bash -n / shellcheck (両 install.sh + hook 本体) / bin/lint-absolute-paths.sh 全通過
11. Phase 5: agent/install.sh のみ明示 stage → /commit skill で commit (agent repo)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## 検討経緯

再発防止案として 3 案を比較した:
1. namespace 分離 (~/.claude/scripts/backlog-md/ 専用 dir): 変更範囲が広く settings.json / plist / script 相互参照すべて改修が必要
2. cleanup list から 5 file を除外のみ: 最小変更だが「install.sh 一発で全体反映」というユーザー要求が実現しない
3. manifest ベース cleanup に再設計: 変更範囲が今回の障害範囲を超える

ユーザー指示「install.sh を実行したらちゃんと全体に反映されて、個別実行も出来るという状態をキープしろ」に対し、案 2 + chain 呼び出しの複合を採用。理由: 変更範囲最小 + install 順序依存を除去 + backlog.md.all の standalone 実行を破壊しない。

critic (%36) review で Conditional Go。指摘 5 件を lead が直接確認して全件採用:
- SC1010: shellcheck 実測で hook:173 の bbh_log done を再現
- Phase 3 の実行 pane 条件: hook:70-79 の skip 分岐を読み、lead pane が TMUX_PANE=%35 + role=lead で条件を満たすことを実測
- post-chain 存在確認: copy_script が file 単位 cp で transaction でないことを確認 → 5 file 存在確認 loop を Phase 1 に追加
- launchd 登録切り分け: 登録状態未実測だったので Phase 3 冒頭に launchctl print 分岐 + 未登録時の installer 再実行を追加
- agent repo commit の明示 stage: git status 実測で docs/architecture.md ほか 3 file の無関係差分を確認

TASK-1 (Backlog Hub UI リフレッシュ) と作業対象が重複しないよう Phase 分離: TASK-1 は renderHtml() 改修、本 task は install.sh + hook 診断 log。両者は同じ 5 file の配布復旧を必要とするため、install.sh 修正が先に merge されると TASK-1 の live 反映も楽になる。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
agent install との配布衝突解消 + chain install 化を前セッション f139919/df9511e で実装、全 15 AC 達成 (chain 実行 / hook SC1010 修正 / launchctl print / healthz / hook 手動発火 / lint 全通過)。本セッション Phase 2 で hub server の ~/.claude/scripts/ コピー配布を廃止し launchd 直接参照化したため、AC #1/#3/#6/#7/#11 が言及する『5 file 配布』は現在『2 file (hook + lib) 配布 + hub server は repo 内 scripts/ 直接参照』に進化。配布衝突解消と個別 install 完結の趣旨は維持。親 repo warn list も Phase 2.5 (3f15c1e) で新配布先に整合済み。
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->
