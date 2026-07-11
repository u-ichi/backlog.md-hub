---
id: TASK-6
title: サイドバー Status/Label/Priority filter を複数選択 OR 化
status: Done
assignee: []
created_date: '2026-07-11 04:05'
updated_date: '2026-07-11 08:12'
labels:
  - frontend
  - ui
  - hub
dependencies: []
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

### 初期方針 (2026-07-11 04:05 UTC 時点)

- Backlog.md Hub の Web UI (scripts/backlog-hub-server.js の renderHtml() 埋め込み HTML) で、サイドバー Filter セクションの Status / Label / Priority を、既存 Repos filter と同型の toggle chip + Set ベース複数選択 OR 絞り込みに変更する。
- <select multiple> は使わず、Repos (#repoNav) の click 委譲 + aria-pressed + Set (state.repoSel) パターンを流用する。
- 選択 Set は state に持つ (statusSel / labelSel / prioritySel = new Set())。空 Set = 全件表示。
- グループ内 OR、グループ間 AND、text / Repos filter との組み合わせは従来どおり AND。
- Label 値は空値除外 (.filter(Boolean)) してから sort。
- click 直後の即時反映のため、chip 再描画関数 renderFilterChips() を render() から毎回呼ぶ (Repos 側の renderSidebar と同型の呼び出し位置)。auto-reload で消えた値は Set から prune。
- 永続化 (localStorage / URL) と件数表示は scope 外。

### 実 UI 目視後の方針変更 (A 案適用、2026-07-11)

- 表示順序を Status → Priority → Label に変更 (Label を最下段)。
- Status / Priority は chip 直置きのまま維持 (3 値ずつでコンパクト)。
- **Label だけ** 元の 「Label: All ▾」 compact button に閉じ、click で popup dropdown を開いて中で複数選択する形に変更。理由: chip 直置きだと label 106 個で sidebar が肥大化するため、実 UI 目視でユーザー判断により方針変更。button label は選択数に応じて 「All ▾」/「<value> ▾」/「N selected ▾」。popup 外 click / Esc で閉じる。popup 開閉状態は state.labelPickerOpen で保持し、30 秒 auto-reload で状態を維持。
- popup 内 chip click で renderFilterChips() が innerHTML で chip を再生成すると元 button が DOM detach され、document click ハンドラの closest(#labelPickerBtn, #labelPickerPop) が null を返して outside 判定で popup が誤爆 close する問題があった。document click ハンドラ冒頭に `event.target.isConnected` guard を追加して回避。
- allTasks() で labels を normLabel で正規化 (`["]` strip + 空値/重複除外) を追加。task file の壊れた YAML list 残骸 (例: '["慶應"', '"データスキーマ"', '"マイルストーン"]') を hub 側で防御的に無害化するため。
- chips button に max-width: 100%; min-width: 0; overflow-wrap: anywhere; text-align: left; white-space: normal を追加。mobile 幅で長い非改行 label が overflow しないようガード。
- (別作業) cliniconnect-dataprocessor 側の 7 task の壊れた labels を backlog CLI 経由で正規化 (今 commit では同 repo の backlog/ が git 管理外のため対象外)。

## 参照 plan

/Users/u1/.claude/plans/filter-1-repos-or-filter-1-repos-or-z-proud-walrus.md

## 見積

- agent 実行: 1 セッション、実装 + ブラウザ実測で 20〜40 分
- 人間側関与: 完成 UI の受け入れ確認 1 回 (数分)
- 不確実性: chip の見た目調整 (label 多数時の wrap / モバイル幅) で往復 1 回増える可能性
- カレンダー期間: 人間レビュー 1 回の可用性次第 (即応なら当日中)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 サイドバーの Status filter で複数値を選択すると OR 絞り込みされ、いずれかに合致する task が表示される
- [x] #2 Label filter で複数値を選択すると OR 絞り込みされる
- [x] #3 Priority filter で複数値を選択すると OR 絞り込みされる
- [x] #4 Repos filter・text 検索・他 filter との組み合わせは AND として従来どおり動く
- [x] #5 chip クリック直後に aria-pressed / 選択色が即時反映される (30 秒待たない)
- [x] #6 全 chip 解除で全件表示に戻る
- [x] #7 30 秒 auto-reload 後も選択状態が保持され、データから消えた値は Set から自動 prune される
- [x] #8 node --test tests/ と bash tests/install-backlog-launchd.test.sh に regression がない
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
- [ ] state.statusSel / labelSel / prioritySel を new Set() で追加
- [ ] HTML の <select> 3 つを .fgroup + .chips コンテナに置換 (id は継承)
- [ ] renderFilterChips() を新設し render() から呼ぶ (即時再描画)
- [ ] Label 値の .filter(Boolean) と Set prune を実装
- [ ] filteredTasks() の等値判定を Set OR 判定に置換
- [ ] click 委譲ハンドラを 3 chip コンテナに追加 (els.nav と同型)
- [ ] CSS: .fgroup / .chips / max-height:30vh + .frow select 系削除
- [ ] setOptions / selectedValues の残骸整理
- [ ] node --check と standalone 空き port 起動でブラウザ実測 (chrome-devtools MCP)
- [ ] 既存テスト実行 (node --test + bash install-backlog-launchd.test.sh)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## 検討経緯

- ユーザー要望「サイドバーの filter を 1 個だけ選べるようにするのではなく、repos と同じく複数要素で OR 絞り込みできるようにしたい」を受け、Repos filter (state.repoSel = new Set() + click 委譲 + aria-pressed + accent CSS) をそのまま手本とする方針を採用。
- <select multiple> は Ctrl/Cmd+click 前提で操作性が悪く、Repos の UI と操作体系が乖離するため不採用。
- critic (wK:p2) レビューで 5 件の指摘を受け、全件採用: (1) render() が refreshFilters を呼ばない問題 → renderFilterChips を render() 内から呼ぶ、(2) .fgroup 配置と Label max-height を確定仕様化、(3) label 値の空値除外、(4) 検証は BACKLOG_HUB_PORT で空き port 起動 (稼働中 6419 は変更前プロセスなので対象外)、(5) 既存テストは node --test と bash install-backlog-launchd.test.sh を別コマンドで実行 + node --check 追加。
- 永続化・件数表示は現状の Repos filter に無く、最小変更方針で scope 外とした。

### 方針変更経緯 (2026-07-11 追記)

- 初期 chip 案で lead が実 UI (稼働 6419 hub) を Playwright screenshot で目視したところ、Label 106 個の chip が sidebar を圧迫し実用性が低いと判定。
- ユーザーに「元々のインタフェース (compact な All ▾) で複数チェック」への切替方針を確認し、A 案 (Label のみ popup dropdown、Status/Priority は chip 継続) を採用。順序も Status → Priority → Label に変更。
- 実装後の Playwright 実測で chip click 時に popup が閉じるバグを検出。原因は renderFilterChips が innerHTML で chip button を再生成することで元 button が DOM detach され、document click ハンドラの outside 判定が誤爆すること。document click ハンドラ冒頭で event.target.isConnected guard を追加して修正。再度 Playwright で 2 個連続選択 → button label 「2 selected ▾」→ outside click close → Esc close → label 絞り込み即時反映を全て pass 確認。
- 別 repo (cliniconnect-dataprocessor) の 7 task に含まれる壊れた labels ('["慶應"', '"データスキーマ"', '"マイルストーン"]' 等の YAML list 残骸) は、hub 側 normLabel での防御と repo 側の CLI 経由修正の両方で対処。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Backlog.md Hub の Web UI サイドバー Filter の Status / Label / Priority を、Repos filter と同型の toggle chip + Set ベース複数選択 OR 絞り込みに変更。scripts/backlog-hub-server.js 1 file 変更 (44 insertions / 44 deletions)。CSS で .fgroup / .chips を新設し、renderFilterChips() を render() 内から毎回呼ぶことで chip クリック直後の aria-pressed 即時反映を実現。Label 値は .filter(Boolean) で空値除外、auto-reload で消えた値は Set から prune。verifier が mobile 390x844 実 DOM で overflow 0px、desktop 1280x800 で 1 行表示 regression なし、Node/shell tests PASS を確認。
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->
