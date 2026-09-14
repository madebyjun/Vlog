# Vlog Import Script

Osmo Action 5 と DJI Mic 2（2台）で撮影した素材を、外付けSSD内のプロジェクト構成へ自動整理する個人用スクリプトです。  
シェルスクリプト版（`newvlog.sh`）と、同じ処理を移植した Raycast 拡張版（[`raycast-newvlog/`](raycast-newvlog/README.md)）があります。  
このリポジトリは公開していますが、Issue / Pull Request を含むコントリビューションは受け付けていません。

## このスクリプトが解決すること

- 複数デバイス（Osmo Action / DJI Mic x2）の素材を一括検出して転送
- 撮影日時ベースで日付ごとに素材を分類
- 04:00 を日付切替時刻として、深夜撮影を前日扱いに調整
- プロジェクトフォルダの新規作成・既存選択・日付単位のスキップを対話的に実行
- 転送前にSSDの空き容量をチェック
- 転送済み履歴（`.import_history`）で重複転送を防止
- 転送失敗を無言で成功扱いにせず、失敗ファイルを一覧表示

## リポジトリ構成

```text
.
├── newvlog.sh          # シェルスクリプト版
├── raycast-newvlog/    # Raycast 拡張版（newvlog.sh のロジックを TypeScript に移植）
├── README.md
└── LICENSE
```

## 動作環境・依存コマンド

- macOS
- `zsh`
- `diskutil`
- `rsync`
- `df` / `stat` / `realpath`
- `open`
- `date`（`-j`, `-v` オプションを使用）

Linux 互換は想定していません（`diskutil` / `open` / `date` オプション依存のため）。

## SSD側の前提ディレクトリ構成

スクリプトは、指定したSSDのマウントポイント配下に次の構成がある前提で動きます。

```text
<SSD_MOUNT>/
└── 001 Camera/
    ├── Footage/
    │   ├── .import_history   # 初回実行時に自動作成
    │   ├── TIER_1__KEEP/     # 必要に応じて自動作成
    │   ├── TIER_2__STORE/    # 必要に応じて自動作成
    │   └── TIER_3__TEMP/     # 必要に応じて自動作成
    ├── _Template/            # 任意（新規作成時に中身をコピー）
    └── _Assets/              # 任意（新規作成時に Assets シンボリックリンク作成）
```

`001 Camera/Footage` が存在しない場合はエラー終了します。

## 初期設定

### 1. 実行権限

```bash
chmod +x ./newvlog.sh
```

### 2. SSD_UUID の設定方法（優先順位あり）

スクリプトは保存先SSDを UUID で特定します。優先順位は次の通りです。

1. CLI引数: `--ssd-uuid`
2. 環境変数: `SSD_UUID`
3. ローカル設定ファイル: `.newvlog.local`

`.newvlog.local` は `newvlog.sh` と同じディレクトリで読み込まれます（`.gitignore` 対象）。

```bash
# .newvlog.local
SSD_UUID="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
```

> **注意:** `.newvlog.local` は現在 `source` で読み込まれるため、中身はシェルスクリプトとして実行されます。自分で作成・管理したファイルだけを置いてください。（`KEY=VALUE` 専用パーサーへの置き換えは [#15](../../issues/15) で取り込み予定）

UUID は例えば次で確認できます。

```bash
diskutil list
diskutil info <ボリューム名>
```

## 実行方法

### ヘルプ

```bash
./newvlog.sh --help
```

Usage:

```text
./newvlog.sh [--ssd-uuid UUID]
```

### 実行例

```bash
# 1) CLI引数で指定
./newvlog.sh --ssd-uuid XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX

# 2) 環境変数で指定
SSD_UUID=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX ./newvlog.sh

# 3) .newvlog.local に設定済みなら
./newvlog.sh
```

エラーで終了するときは、Terminal が自動で閉じても内容を読めるよう Enter キー入力を待ちます（非対話実行では待ちません）。

## 実行時の対話フロー

### 実行前

- 保存先SSDを UUID で確認
- `001 Camera/Footage` の存在確認
- `001 Camera/Footage/.import_history` を読み込み（作成できない場合はエラー終了）
- `/Volumes/*` をスキャンして、保存先SSD以外の接続ボリュームを調査

### デバイス検出

- Osmo Action 系: `DCIM/DJI_001` があるボリュームを検出
  - 転送先サブフォルダ: `DJI_001`
  - 日付抽出対象ファイル名例: `DJI_20251019114536_0001_D.MP4`
- DJI Mic 系: `DJI_Audio_001` があるボリュームを最大2台検出
  - 1台目転送先: `DJI_Audio_001`
  - 2台目転送先: `DJI_Audio_002`
  - 日付抽出対象ファイル名例: `DJI_29_20251017_175848.WAV`

### 容量チェック

デバイスごとに、転送予定サイズ + 安全マージン（`SPACE_MARGIN_GB=2`）がSSDの空き容量を超える場合、転送前に警告します。

- `[1]` 中止する（データを整理してから再実行）
- `[2]` このまま転送を開始する（入るところまで転送）

### 日付整理とプロジェクト選択

- 日付・時刻はファイル名の正規表現から抽出
- `CUTOFF_TIME=04:00` より前の時刻は前日扱い
- 日付ごとに既存プロジェクト（`<YYYY-MM-DD>-*`）を全Tierから検索
- 既存を使う / 新規プロジェクトを作る（`[0]`）/ この日付をスキップ（`[s]`）を選択
- 新規作成時:
  - タイトル入力（未入力時は `NewProject`、`/` は使用不可、`[s]` でスキップ）
  - Tier選択
    - `TIER_1__KEEP`
    - `TIER_2__STORE`
    - `TIER_3__TEMP`
  - 既存名と重複時は `-1`, `-2` ... を付けて作成
  - `_Template` があれば内容をコピー
  - `_Assets` があれば `Assets` シンボリックリンクを作成
  - テンプレートのコピーや Assets リンク作成に失敗した場合は、作りかけのプロジェクトフォルダを削除してエラー終了（実パスが選択した Tier 配下であることを確認してから削除）
- スキップした日付は履歴に記録されないため、次回実行時に再び転送対象になります

### 転送中

- 転送は `rsync -a --progress`
- 除外パターン: `*.LRF`
- 転送成功時のみ `.import_history` に `DEVICE_NAME:ファイル名` を追記
- 履歴への追記に失敗した場合は、以降の成功も記録されなくなるため即中止
- 転送に失敗したファイルは履歴に記録せず、処理を続行

### 実行後

- 日付ごとの成功件数（失敗があれば失敗件数も）を表示
- 対象プロジェクトフォルダを `open` で表示
- 失敗ファイルがあれば一覧を表示し、終了コード 1 で終了（再実行すれば失敗分だけ再転送されます）
- `.import_history` により次回以降の重複転送を抑止

## 転送ルール詳細

- 転送対象は「履歴未登録」かつ「除外パターン非一致」かつ「日付抽出可能」なファイルのみ
- 日付抽出できないファイルはスキップ（警告表示なし）
- デバイス未接続時は何も転送せず正常終了
- 新規ファイルなしの場合も正常終了

## トラブルシュート

### `SSD_UUID が未設定です。`

`--ssd-uuid`、`SSD_UUID` 環境変数、`.newvlog.local` のいずれかを設定してください。

### `保存先 SSD が見つかりません。`

UUID が誤っているか、SSDが未接続です。`diskutil info <UUID>` で確認してください。

### `保存先フォルダが見つかりません: .../001 Camera/Footage`

SSD内の前提フォルダ構成を作成してください。

### `SSDの空き容量が不足しています`

SSDの空き容量を確保してから再実行してください。`[2]` を選ぶと入るところまで転送し、入らなかったファイルは失敗一覧に表示されます。

### デバイスが検出されない

接続先ボリューム直下に以下が存在するか確認してください。

- Osmo Action: `DCIM/DJI_001`
- DJI Mic: `DJI_Audio_001`

## Raycast 拡張版

`raycast-newvlog/` は `newvlog.sh` と同じ処理を Raycast の画面から実行できるようにしたものです。`.import_history` の形式や Tier 定義はシェル版と共通なので、どちらで取り込んでも履歴は引き継がれます。セットアップと使い方は [raycast-newvlog/README.md](raycast-newvlog/README.md) を参照してください。

## 開発メモ: Codex 版の修正について

2026-02-17 に Codex が作成・マージした修正（#11 / #13 / #14）は、実運用している手元版と乖離していたため、main を手元版に戻しました。Codex 版の状態は [`archive/codex-hardening-2026-02`](../../tree/archive/codex-hardening-2026-02) ブランチに保全しており、[#15](../../issues/15) で手元版（シェル版 + Raycast 版）に順次取り込み直す予定です。

## 非対応 / 運用ポリシー

- 本リポジトリは個人運用のため、Issue / Pull Request ともに受け付けていません。
- 利用は自己責任でお願いします。
