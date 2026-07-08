---
id: TASK-4
title: OSS 公開作業 (LICENSE / scrub / 履歴リセット / repo public 化)
status: To Do
assignee: []
created_date: '2026-07-08 14:54'
updated_date: '2026-07-08 15:41'
labels:
  - backlog-hub
  - oss
  - release
dependencies:
  - TASK-3
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 決定事項

repo `u-ichi/backlog.md-hub` を GitHub で public 化する。公開固有 Phase (0 / 2.5 / 5 / 6) を本 task が担当する。TASK-3 (Phase 3 配置整理 / Phase 4 hook 縮退) 完了後に着手する。

### 決定内容
- LICENSE: MIT、Copyright Yuichi Uemura (author 名と一致)
- ドキュメント: 英語 README.md + 日本語 README.ja.md
- launchd label: OSS 向け label に改名し、旧 label は installer migration / rollback のためだけに literal を保持する
- 履歴: orphan branch 方式で initial を作り直し
- backlog/ (task 管理 file) は公開に含める (dogfooding)、task 本文の個人環境パスは scrub
- HOST default: `0.0.0.0` → `127.0.0.1` (認証なし HTTP UI のため)、Tailscale 越し利用は plist render 時に `BACKLOG_HUB_HOST=0.0.0.0` で opt-in
- config path: legacy config path から XDG_CONFIG_HOME 配下の `backlog-md-hub/config.json` へ installer が自動 migration

### 対象外 (別 task)
- TASK-3 が担当する Phase 3 (配置整理) / Phase 4 (hook 縮退) は本 task に含めない
- 親 repo 側の Backlog.md CLI skill 更新は公開後 follow-up (本 task 対象外)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 GitHub repo u-ichi/backlog.md-hub が public 表示になっている (gh repo view で visibility=PUBLIC)
- [ ] #2 LICENSE (MIT, Copyright Yuichi Uemura) が repo root に存在し、GitHub の repo overview で MIT 表示になる
- [ ] #3 README.md (英) + README.ja.md (日) の 2 file が存在し、requirements / quick start / config reference / Remote access (Tailscale) / Claude Code 統合 (optional) / uninstall 節を含む
- [ ] #4 .gitignore に .codex/ が追加され、ignored 扱いになる
- [ ] #5 launchd label が OSS 向け label に改名され、旧 label は migration / rollback 用 literal 以外に残っていない
- [ ] #6 scrub gate 通過: tracked file の走査で指定 pattern は migration / rollback 用 literal と README の説明行だけに限定される
- [ ] #7 履歴リセット完了: log で public 化用の 1 commit のみ、backup bundle が repo 外に保全
- [ ] #8 fresh clone で導入 flow が成立する: 別 tmp dir で clone → launchd installer preflight → healthz OK + repo child spawn + task view 表示
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
- [x] Phase 0: .gitignore に .codex/ 追加、ignored 状態を確認
- [x] Phase 2.5: 親 repo 側 installer の stale warn list から hub server 配布物を除去
- [ ] Phase 5-a: backlog task 本文 scrub (backlog CLI 経由): 個人環境パス、local download path、private plan path、legacy port state 記述
- [ ] Phase 5-b: AGENTS.md 更新 (private plan 参照削除、新 layout 反映)
- [ ] Phase 5-c: README.md (英) 全面書き換え + README.ja.md 新設 (unofficial companion for Backlog.md 明記、requirements / quick start / Tailscale / Claude Code 統合 / uninstall)
- [ ] Phase 5-d: LICENSE (MIT, Copyright Yuichi Uemura) を repo root に追加
- [ ] Phase 5-e: scrub gate 実行 (tracked file 走査で意図的な migration literal 以外 0 件確認)
- [ ] Phase 6-a: backup bundle 作成 (repo 外に保全)
- [ ] Phase 6-b: orphan branch 準備 → 全 file stage → staged 検査 gate 実行
- [ ] Phase 6-c: initial commit → main branch 差し替え → remote へ反映
- [ ] Phase 6-d: gh repo edit --visibility public + description / topics 設定
- [ ] Phase 6-e: fresh clone 通し確認 (別 tmp dir で clone → launchd installer preflight → healthz + repo 認識 + task view)
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## 検討経緯

TASK-3 の AC が hub 単体 OSS 化と責務統合 (child manager / URL バグ修正) に閉じており、公開固有作業 (LICENSE / scrub / 履歴リセット / repo public 化) が含まれていないため、別 task として分離した。TASK-3 の Phase 3/4 (配置整理 / hook 縮退) が repo 内部整理、本 task が公開手続き、と責務を分ける。

## 依存関係

TASK-3 の Phase 3 (配置整理) / Phase 4 (hook 縮退) 完了 → 本 task の Phase 5 (scrub + docs + LICENSE) → Phase 6 (履歴リセット + 公開設定)。Phase 0 (.gitignore に .codex/) と Phase 2.5 (親 repo warn list 更新) は TASK-3 の Phase 3 と並行実行可 (稼働中 launchd を壊さない)。

## critic review 反映

critic から Conditional Go + must-fix 5 件を受領し全採用: (1) Phase 1 で旧稼働系温存 (2) Phase 2.5 前倒し (3) Phase 2 rollback 手順 (4) preflight 検査 (5) scrub gate 分離。本 task の AC / Plan にはこれらの反映結果 (scrub gate 分離検査 / fresh clone 通し確認) を組み込んでいる。

## 参考

- 上流 MrLesk/Backlog.md は MIT、本 task の LICENSE と整合
- 履歴リセットは private 時代の SHA が外部未公開のため露出リスク実質ゼロ、URL 継続

## 見積

- agent 実行: 1〜2 セッション、合計 2〜3 時間 (Phase 5 の README 執筆と Phase 6 の公開通し確認が主)
- 人間側関与: 承認 2 回 (履歴リセット + remote 反映直前 / public 化直前)、各 5〜10 分。README 英文レビュー 1 回 15 分
- 不確実性: fresh clone 通し確認で発見される欠落 (config schema / preflight 検査の穴)、上流 backlog CLI 挙動
- カレンダー期間: 人間レビュー 2 回 × 可用性で 1〜2 日 (TASK-3 完了待ち含めず)
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Description の ## 決定事項 に決定内容が記録されている
- [x] #2 Implementation Plan に決定事項を分解した todo がある
- [x] #3 Implementation Notes に検討経緯が記録されている
<!-- DOD:END -->
