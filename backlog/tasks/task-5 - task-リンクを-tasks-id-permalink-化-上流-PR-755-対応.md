---
id: TASK-5
title: 'task リンクを /tasks/:id permalink 化 (上流 PR #755 対応)'
status: Done
assignee: []
created_date: '2026-07-11 01:19'
updated_date: '2026-07-11 02:19'
labels:
  - backlog-hub
  - url
  - upstream
dependencies: []
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

Backlog.md 公式が PR #755 (2026-07-10 merged) で `/tasks/:id` deep link に対応した。TASK-3 で
上流未対応を理由に repo top URL へ退行させていた taskUrlFor を、task 直リンク生成に戻す。

- `scripts/backlog-hub-server.js:717-721` の taskUrlFor を `${repoUrl}tasks/${encodeURIComponent(taskId)}` に変更
- frontend (kanban カード renderCard:1364 / list view:1373) は API の browser_url をそのまま href に使うため、
  server 側の 1 関数変更で kanban / list の両方が直リンク化される
- repo header リンク (:1310) は repo top のまま (変更しない)
- 未コミットの Tailscale listener 変更と hunk 分離。commit / 報告を混ぜない
- CHANGELOG.md の [Unreleased] に変更エントリ追記
- 対応済み backlog CLI (git 最新版) 前提。手元 v1.47.1 は未対応だが fallback は作らない
- URL 形式は `/tasks/:id` (title slug 無し) に統一。`/board/:id` は使わない
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 taskUrlFor が ${repoUrl}tasks/${encodeURIComponent(taskId)} を返す
- [x] #2 standalone 検証: BACKLOG_HUB_CONFIG + BACKLOG_HUB_PORT の env 起動 + curl /api/tasks で browser_url が /tasks/TASK-N 形式になっていることを実測
- [x] #3 system-integrated 検証: 本番 hub の再起動 (個別承認) 後、hub UI kanban から大文字 id (TASK-N) の task modal が別 tab で開く (CLI 未更新なら未実施と明記)
- [x] #4 変更は taskUrlFor と CHANGELOG.md のみ。Tailscale listener 差分と混ぜない
- [x] #5 既存テスト (node --test tests/listener-manager.test.js) が変更後も着手前と同結果
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
- [ ] 検証 4 の着手前基準取り: node --test tests/listener-manager.test.js の結果を記録
- [ ] taskUrlFor を permalink 生成に変更 (scripts/backlog-hub-server.js:717-721、encodeURIComponent 使用)
- [ ] CHANGELOG.md の [Unreleased] にエントリ追記
- [ ] standalone 検証 (検証 1): tmp fixture + env 起動 + /api/tasks read-back で /tasks/TASK-N 形式を実測
- [ ] tests 再実行 (変更後): 着手前と同結果を確認
- [ ] system-integrated 検証 (検証 2): 本番 hub の再起動は個別承認を取ってから実行、CLI 未更新なら未実施として報告
- [ ] hunk 分離を確認して commit (Tailscale listener 差分を混ぜない)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## 検討経緯

- 発端: 上流 PR #755 が /tasks/:id / /tasks/:id/:title / /board/:id の deep link 対応 (2026-07-10 merge)。ユーザーが「kanban からのリンクや terminal でのリンクなどを task 直リンクに直してほしい」と依頼
- TASK-3 で「上流未対応 → repo top へ退行」の短期対応をしていた。今回はその解除
- URL 形式は `/tasks/:id` に統一 (title slug 無し、`/board/:id` も未使用)。上流実装は大文字小文字・prefix 省略を許容 (App.tsx / urlHelpers.ts / task-id.ts で確認)
- fallback を作らない方針をユーザーが確定 (手元 CLI 更新は別途進行中)
- 実装は 1 行変更で済むため、TASK-3 で defer した hub 内部モジュール分割は今回も見送り
- Tailscale listener 未コミット差分と hunk が離れていることを critic が git diff で確認済み。commit 時に分離
- system-integrated 検証で本番 hub を再起動すると Tailscale listener 変更も同時有効化されるため、独立承認軸として扱う
- critic (codex pane w6:p2) レビュー: Conditional Go、Go 条件 4 点を plan に反映済み

## 2026-07-11 実装・検証結果

- taskUrlFor を /tasks/:id permalink 生成に変更し、CHANGELOG.md [Unreleased] に追記。
- standalone 検証: BACKLOG_HUB_CONFIG fixture + BACKLOG_HUB_PORT=17950 + curl /api/tasks で TASK-1/TASK-20 の browser_url が /tasks/TASK-N 形式になることを確認。
- 既存テスト: node --test tests/listener-manager.test.js は変更前後とも 11 pass / 0 fail。
- base repo task-reference.md は /tasks/TASK-N 形式へ更新し、./install.sh --overwrite で ~/.claude / ~/.codex へ配布済み。
- system-integrated 検証 (本番 hub 再起動 + ブラウザ確認) は lead 担当のため implementor 側では未実施。

## 2026-07-11 system-integrated 検証

- 本番 hub を再起動 (承認取得済み、実行はユーザー)
- curl /api/tasks で全 10 repo の browser_url が /tasks/TASK-N 形式に切り替わったことを実測
- 直リンク /tasks/TASK-14 が SPA shell を 200 で返す (PR #755 の SPA fallback)
- /api/tasks/TASK-14 が JSON {id:TASK-14, title:..., status:Done} を返す (PR #755 の deep link API)
- 手元 backlog CLI は PR #755 対応版で稼働
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Backlog.md 上流 PR #755 (2026-07-10 merge) の /tasks/:id deep link 対応を受け、hub の taskUrlFor を repo top URL 退行 (TASK-3) から permalink 生成 `${repoUrl}tasks/${encodeURIComponent(taskId)}` に戻した。frontend は API の browser_url をそのまま href に使うため、taskUrlFor 1 行変更で kanban / list の両方が直リンク化。CHANGELOG.md [Unreleased] に追記。base repo の home/rules/task-reference.md も /tasks/TASK-N 形式に更新し install.sh --overwrite で ~/.claude / ~/.codex へ配布 (source / generated / Claude 配布先 / Codex 生成物の 4 点 read-back で反映確認)。standalone 検証は fixture repo + BACKLOG_HUB_CONFIG/PORT 起動 + curl /api/tasks で /tasks/TASK-N 形式を実測、system-integrated 検証は本番 hub 再起動後に全 10 repo の browser_url 実測 + /tasks/TASK-14 が 200 で SPA shell を返し /api/tasks/TASK-14 が JSON を返すことを確認。既存テスト (node --test tests/listener-manager.test.js) は変更前後とも 11 pass / 0 fail。base repo TASK-14 (上流 PR 出す task) も PR #755 merge 済みとして Done 化。
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->
