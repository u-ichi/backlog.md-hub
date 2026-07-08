---
id: TASK-1
title: Backlog Hub UI リフレッシュ (v2) 取り込み
status: In Progress
assignee: []
created_date: '2026-07-07 03:35'
updated_date: '2026-07-08 15:41'
labels:
  - ui
  - backlog-hub
  - design-refresh
dependencies: []
priority: medium
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

- デザインハンドオフ (high-fidelity prototype + 移植手順表) を `scripts/backlog-hub-server.js` の `renderHtml()` に取り込む。独自アレンジしない
- 変更対象は `renderHtml()` template literal のみ。サーバー側ロジック (repo 発見 / task parse / API / caching / graceful shutdown) は触らない
- fetch ベースの既存 `load()` + 30 秒 polling を維持する。プロトタイプの `MOCK_DATA` / mock `load()` / ハードコード `statusColumns` は持ち込まない
- statusColumns のサーバー側注入は現行維持
- live 反映は repo 内 script 更新後、launchd installer で hub を再起動し、healthz と UI を確認する
- スコープ外差分は本 task では編集しない。commit にも混ぜない
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 board view で repo section / milestone header / 3 列 board / progress bar / priority 左ボーダー (high/critical) / Done 列 opacity が仕様どおり表示される
- [ ] #2 list view 切替が動く
- [ ] #3 theme toggle が dark と light を切替、localStorage で保持する
- [ ] #4 sidebar Repos クリックで repo フィルタが toggle し、複数選択が OR、0 件 repo が dim になる
- [ ] #5 Search / Status / Label / Priority が input イベントで即時反映される
- [ ] #6 viewport 920px 以下で topbar + drawer、810px 以下で board 2 列、480px 以下で 1 列縦積みになる
- [ ] #7 カードリンクが純正 Backlog.md web UI の URL (task_url) を指す
- [ ] #8 UI の repo 数 / task 総数が /api/tasks 実データと一致する (mock 混入が無いことを確認)
- [ ] #9 live URL (port 6419) で healthz ok + 新 UI が表示される
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. `<style>` 全体をプロトタイプ 12-363 行で置換 (light + dark, [data-theme="dark"] + @media prefers-color-scheme)
2. `<body>` 冒頭に .topbar + .backdrop を追加、.sidebar HTML を置換 (#repoFilter multi-select 削除)
3. script: state.repoSel (Set) / STATUS_KEYS / shortDate() を追加、els.repo を削除
4. filteredTasks / refreshFilters / render を repoSel ベースに調整、summary 文言を 'N tasks · M visible' に
5. renderSidebar / renderBoard / renderMilestoneGroups / renderStatusBoard / renderCard / renderList をプロトタイプ版で置換
6. repoNav click delegation / theme toggle IIFE / drawer IIFE を追加
7. 機械チェック 4 条件を満たす (template placeholder は 1 箇所のみ / バッククォート 0 / MOCK_DATA・PROTOTYPE・ハードコード statusColumns 0 / els.repo・repoFilter 0)
8. node --check → 一時 port 6499 で起動 → chrome-devtools MCP で board/list・dark/light・repo フィルタ・mobile 幅を実測 → UI の repo/task 数が /api/tasks 実データと一致することを確認
9. ./install.sh → cmp → LaunchAgent 再起動 → 起動時刻更新 + healthz + live URL 実機確認
<!-- SECTION:PLAN:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Description の ## 決定事項 に決定内容が記録されている
- [ ] #2 Implementation Plan に決定事項を分解した todo がある
- [ ] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->
