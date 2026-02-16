#!/usr/bin/env zsh
set -e # エラー時に即終了
# set -eなので、エラー発生しても継続させるには`|| true`を付ける必要があります

# ==========================================
# 0. 設定エリア
# ==========================================

# --- SSD設定 ---
SSD_SUBPATH="001 Camera/Footage"
TEMPLATE_SUBPATH="001 Camera/_Template"
ASSETS_SUBPATH="001 Camera/_Assets"
DEFAULT_TITLE="NewProject"

# SSD_UUID の優先順位:
# 1) CLI引数 --ssd-uuid
# 2) 環境変数 SSD_UUID
# 3) ローカル設定ファイル .newvlog.local
LOCAL_CONFIG_FILE="$(cd "$(dirname "$0")" && pwd)/.newvlog.local"
ENV_SSD_UUID="${SSD_UUID:-}"
SSD_UUID=""

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    print -r -- "$value"
}

is_valid_ssd_uuid() {
    local value="$1"
    [[ "$value" =~ ^[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$ ]]
}

parse_local_config() {
    local file="$1"
    local line=""
    local key=""
    local value=""
    local line_no=0

    while IFS= read -r line || [[ -n "$line" ]]; do
        line_no=$((line_no + 1))
        line="$(trim_whitespace "$line")"
        [[ -z "$line" ]] && continue
        [[ "$line" == \#* ]] && continue

        if [[ "$line" != *=* ]]; then
            print "❌ .newvlog.local:${line_no}: 無効な形式です。KEY=VALUE 形式で記述してください。"
            exit 1
        fi

        key="$(trim_whitespace "${line%%=*}")"
        value="$(trim_whitespace "${line#*=}")"

        if [[ -z "$key" ]]; then
            print "❌ .newvlog.local:${line_no}: キー名が空です。"
            exit 1
        fi

        if [[ "$key" != "SSD_UUID" ]]; then
            print "⚠️  .newvlog.local:${line_no}: 未知のキー '${key}' は無視します。"
            continue
        fi

        if [[ -z "$value" ]]; then
            print "❌ .newvlog.local:${line_no}: SSD_UUID が空です。"
            exit 1
        fi

        if [[ ("${value[1]}" == "\"" && "${value[-1]}" == "\"") || ("${value[1]}" == "'" && "${value[-1]}" == "'") ]]; then
            value="${value[2,-2]}"
            value="$(trim_whitespace "$value")"
        fi

        if ! is_valid_ssd_uuid "$value"; then
            print "❌ .newvlog.local:${line_no}: SSD_UUID の形式が不正です: $value"
            exit 1
        fi

        SSD_UUID="$value"
    done < "$file"
}

if [[ -f "$LOCAL_CONFIG_FILE" ]]; then
    parse_local_config "$LOCAL_CONFIG_FILE"
fi

if [[ -n "$ENV_SSD_UUID" ]]; then
    if ! is_valid_ssd_uuid "$ENV_SSD_UUID"; then
        print "❌ 環境変数 SSD_UUID の形式が不正です: $ENV_SSD_UUID"
        exit 1
    fi
    SSD_UUID="$ENV_SSD_UUID"
fi

while (( $# > 0 )); do
    case "$1" in
        --ssd-uuid)
            if [[ -z "$2" ]]; then
                print "❌ --ssd-uuid にはUUIDを指定してください。"
                exit 1
            fi
            if ! is_valid_ssd_uuid "$2"; then
                print "❌ --ssd-uuid の形式が不正です: $2"
                exit 1
            fi
            SSD_UUID="$2"
            shift 2
            ;;
        --ssd-uuid=*)
            if ! is_valid_ssd_uuid "${1#*=}"; then
                print "❌ --ssd-uuid の形式が不正です: ${1#*=}"
                exit 1
            fi
            SSD_UUID="${1#*=}"
            shift
            ;;
        -h|--help)
            print "Usage: $0 [--ssd-uuid UUID]"
            exit 0
            ;;
        *)
            print "❌ 不明なオプション: $1"
            print "Usage: $0 [--ssd-uuid UUID]"
            exit 1
            ;;
    esac
done

if [[ -z "$SSD_UUID" ]]; then
    print "❌ SSD_UUID が未設定です。"
    print "   --ssd-uuid / 環境変数 SSD_UUID / .newvlog.local のいずれかで指定してください。"
    exit 1
fi

# --- Tier folders ---
typeset -a TIER_FOLDERS
TIER_FOLDERS=(
    "TIER_1__KEEP"
    "TIER_2__STORE"
    "TIER_3__TEMP"
)

typeset -A TIER_DESCRIPTIONS
TIER_DESCRIPTIONS[1]="重要保管素材 - 重要プロジェクト"
TIER_DESCRIPTIONS[2]="通常保管素材 - 通常プロジェクト"
TIER_DESCRIPTIONS[3]="一時保存素材 - テスト撮影・草稿"

# --- 日付切り替え時刻設定 ---
# この時刻より前に撮影されたファイルは、前日の撮影として扱います
# 形式: "HH:MM" (24時間形式)
# 例: "04:00" → 午前4時より前は前日扱い
CUTOFF_TIME="04:00"

# --- デバイス検出ルール ---
# UUIDではなく、ボリューム内のフォルダ構成で自動検出します
# 検出フォルダ: ボリューム直下に存在するか確認するパス
# 同じ検出フォルダを持つデバイスが複数見つかった場合、発見順に割り当てます
#
# 【設定項目】
# 1. DETECT_PATH: 検出用フォルダパス (ボリュームルートからの相対パス)
# 2. SOURCE_PATH: ファイル読み込み元パス (= DETECT_PATHと同じことが多い)
# 3. DEST_DIRS: 転送先フォルダ名の配列 (複数台ある場合は発見順に割り当て)
# 4. DATE_REGEX: 日付抽出用の正規表現

# --- 除外設定 ---
# パターンに一致するファイルは転送しません (zshのパターンが利用可能)
typeset -a EXCLUDE_PATTERNS
EXCLUDE_PATTERNS=(
    "*.LRF"
)

# [1] Osmo Action
# 検出: DCIM/DJI_001 フォルダの存在
# ファイル名: DJI_20251019114536_0001_D.MP4
OSMO_DETECT_PATH="DCIM/DJI_001"
OSMO_SOURCE_PATH="DCIM/DJI_001"
typeset -a OSMO_DEST_DIRS
OSMO_DEST_DIRS=("DJI_001")
OSMO_DATE_REGEX="DJI_([0-9]{8})([0-9]{6})"

# [2] DJI Mic (最大2台)
# 検出: DJI_Audio_001 フォルダの存在
# ファイル名: DJI_29_20251017_175848.WAV
MIC_DETECT_PATH="DJI_Audio_001"
MIC_SOURCE_PATH="DJI_Audio_001"
typeset -a MIC_DEST_DIRS
MIC_DEST_DIRS=("DJI_Audio_001" "DJI_Audio_002")
MIC_DATE_REGEX="DJI_[0-9]+_([0-9]{8})_([0-9]{6})"


# ==========================================
# 0.5 日付計算ヘルパー関数
# ==========================================

# カットオフ時刻をHHMM形式に変換（コロンを削除）
CUTOFF_HHMM="${CUTOFF_TIME/:/}"

# ファイルの撮影日を計算する関数
# 引数: $1 = YYYYMMDD形式の日付, $2 = HHMMSS形式の時刻
# 戻り値: 調整後の日付（YYYY-MM-DD形式）
calculate_shooting_date() {
    local raw_date="$1"
    local raw_time="$2"

    # 入力検証
    if [[ ! "$raw_date" =~ ^[0-9]{8}$ ]] || [[ ! "$raw_time" =~ ^[0-9]{6}$ ]]; then
        echo ""
        return 1
    fi

    # YYYY-MM-DD形式に変換
    local formatted_date="${raw_date[1,4]}-${raw_date[5,6]}-${raw_date[7,8]}"

    # 時刻をHHMM形式に変換（秒を削除）
    local file_hhmm="${raw_time[1,4]}"

    # 切り替え時刻と比較
    if [[ "$file_hhmm" -lt "$CUTOFF_HHMM" ]]; then
        # カットオフ時刻より前 → 前日として扱う
        date -j -v-1d -f "%Y-%m-%d" "$formatted_date" "+%Y-%m-%d" 2>/dev/null || echo "$formatted_date"
    else
        # カットオフ時刻以降 → そのまま
        echo "$formatted_date"
    fi
}


# ==========================================
# 0.6 Tier Selection Helper Function
# ==========================================

# Prompts user to select a tier and returns the tier folder name
# Returns: TIER_1__KEEP, TIER_2__STORE, or TIER_3__TEMP
select_tier() {
    print "  📦 Select storage tier:" >&2
    print "    [1] TIER_1__KEEP   - ${TIER_DESCRIPTIONS[1]}" >&2
    print "    [2] TIER_2__STORE  - ${TIER_DESCRIPTIONS[2]}" >&2
    print "    [3] TIER_3__TEMP   - ${TIER_DESCRIPTIONS[3]}" >&2
    print -n "  👉 Select tier (1-3): " >&2

    local tier_choice
    read tier_choice

    # Validate input
    while [[ ! "$tier_choice" =~ ^[1-3]$ ]]; do
        print "  ⚠️  Invalid selection. Please enter 1, 2, or 3." >&2
        print -n "  👉 Select tier (1-3): " >&2
        read tier_choice
    done

    echo "${TIER_FOLDERS[$tier_choice]}"
}


# ==========================================
# 1. SSD準備 & 履歴ロード
# ==========================================
print "🔍 SSDを確認しています..."

SSD_INFO=$(diskutil info "$SSD_UUID" 2>/dev/null || true)
if [[ -z "$SSD_INFO" ]]; then
    print "❌ 保存先 SSD が見つかりません。"
    exit 1
fi
SSD_MOUNT=$(echo "$SSD_INFO" | grep "Mount Point" | cut -d: -f2- | xargs || true)

FOOTAGE_ROOT="$SSD_MOUNT/$SSD_SUBPATH"
TEMPLATE_DIR="$SSD_MOUNT/$TEMPLATE_SUBPATH"
ASSETS_DIR="$SSD_MOUNT/$ASSETS_SUBPATH"

if [[ ! -d "$FOOTAGE_ROOT" ]]; then
    print "❌ 保存先フォルダが見つかりません: $FOOTAGE_ROOT"
    exit 1
fi

HISTORY_FILE="$FOOTAGE_ROOT/.import_history"
touch "$HISTORY_FILE"
typeset -A imported_files
while IFS= read -r line; do
    imported_files[$line]=1
done < "$HISTORY_FILE"

print "✅ SSD準備完了 (履歴: $(cat "$HISTORY_FILE" | wc -l | xargs)件)"


# ==========================================
# 2. ボリュームスキャン & デバイス検出
# ==========================================

# SSDのマウントポイントを除外してマウント済みボリュームを収集
typeset -a ALL_VOLUMES
for vol in /Volumes/*(N/); do
    [[ "$vol" == "$SSD_MOUNT" ]] && continue
    ALL_VOLUMES+=("$vol")
done

# デバイス種別ごとの検出結果を格納
typeset -a DETECTED_DEVICES  # "DEVICE_NAME|SOURCE_DIR|DEST_FOLDER|DATE_REGEX" の配列

osmo_count=0
mic_count=0

for vol in $ALL_VOLUMES; do
    # OsmoAction 検出
    if [[ -d "$vol/$OSMO_DETECT_PATH" ]] && (( osmo_count < ${#OSMO_DEST_DIRS} )); then
        osmo_count=$((osmo_count + 1))
        DETECTED_DEVICES+=("OsmoAction_${osmo_count}|${vol}/${OSMO_SOURCE_PATH}|${OSMO_DEST_DIRS[$osmo_count]}|${OSMO_DATE_REGEX}")
    fi

    # DJI Mic 検出
    if [[ -d "$vol/$MIC_DETECT_PATH" ]] && (( mic_count < ${#MIC_DEST_DIRS} )); then
        mic_count=$((mic_count + 1))
        DETECTED_DEVICES+=("DJI_Mic_${mic_count}|${vol}/${MIC_SOURCE_PATH}|${MIC_DEST_DIRS[$mic_count]}|${MIC_DATE_REGEX}")
    fi
done

if (( ${#DETECTED_DEVICES} == 0 )); then
    print "💤 接続されたデバイスが見つかりません。"
    print "\n🎉 全処理完了！"
    exit 0
fi

print "🔎 検出されたデバイス:"
for entry in $DETECTED_DEVICES; do
    print "  ✅ ${entry%%|*}"
done

for DEVICE_ENTRY in $DETECTED_DEVICES; do
    DEVICE_NAME="${DEVICE_ENTRY%%|*}"
    _rest="${DEVICE_ENTRY#*|}"
    SOURCE_DIR="${_rest%%|*}"
    _rest="${_rest#*|}"
    DEST_FOLDER_NAME="${_rest%%|*}"
    DATE_REGEX="${_rest#*|}"

    print "\n════════════════════════════════════════════"
    print "📡 $DEVICE_NAME チェック中..."
    print "════════════════════════════════════════════"
    print "📂 読み込み元: $SOURCE_DIR"


    # --- ファイルスキャン ---
    typeset -A files_by_date
    typeset -U dates_list
    dates_list=()
    setopt NULL_GLOB
    
    has_files=false
    for f in "$SOURCE_DIR"/*; do
        [[ -f "$f" ]] || continue
        fname=$(basename "$f")

        # 【変更点1】履歴チェック (デバイス名:ファイル名 で照合)
        history_key="${DEVICE_NAME}:${fname}"
        if [[ -n "${imported_files[$history_key]}" ]]; then
            continue
        fi

        # 除外パターンにマッチするファイルはスキップ
        skip_file=false
        for pat in $EXCLUDE_PATTERNS; do
            if [[ "$fname" == ${~pat} ]]; then
                skip_file=true
                break
            fi
        done
        $skip_file && continue

        # 【変更点2】正規表現による日付・時刻抽出
        dpart=""
        tpart=""
        if [[ "$fname" =~ $DATE_REGEX ]]; then
            # match配列の1番目と2番目(カッコの中身)を取得
            dpart="$match[1]"  # 日付 (YYYYMMDD)
            tpart="$match[2]"  # 時刻 (HHMMSS)
        fi

        if [[ -n "$dpart" && "$dpart" =~ ^[0-9]{8}$ && -n "$tpart" && "$tpart" =~ ^[0-9]{6}$ ]]; then
            # 撮影日を計算（切り替え時刻を考慮）
            formatted_date=$(calculate_shooting_date "$dpart" "$tpart")

            if [[ -n "$formatted_date" ]]; then
                dates_list+=($formatted_date)
                # ファイル数をカウント（パスは保存しない）
                : ${files_by_date[$formatted_date]:=0}
                files_by_date[$formatted_date]=$((files_by_date[$formatted_date] + 1))
                has_files=true
            fi
        else
            # 日付・時刻が取れなかった場合
            # print "⚠️  スキップ (日付または時刻不明): $fname"
        fi
    done

    if ! $has_files; then
        print "🎉 新しいファイルはありません。"
        continue
    fi
    
    dates_sorted=($(print -l $dates_list | sort))
    print "💡 転送対象の日付: ${dates_sorted[*]}"


    # --- 日付ごとの処理 ---
    typeset -A project_dir_by_date
    typeset -A dest_sub_by_date

    print "\n🛠 フォルダ準備フェーズ..."
    for TARGET_DATE in $dates_sorted; do
        print "\n  📅 [ $DEVICE_NAME ] $TARGET_DATE"

        # 既存フォルダ検索（全tierから検索）
        existing_dirs=()
        for tier in $TIER_FOLDERS; do
            tier_path="$FOOTAGE_ROOT/$tier"
            if [[ -d "$tier_path" ]]; then
                existing_dirs+=("$tier_path"/${TARGET_DATE}-*(/))
            fi
        done
        TARGET_PROJECT_DIR=""
        IS_NEW_PROJECT=false

        if (( ${#existing_dirs} > 0 )); then
            print "  ⚡️ 既存プロジェクトが見つかりました:"
            choices=()
            for d in $existing_dirs; do
                choices+=($(basename "$d"))
            done
            
            i=1
            for c in $choices; do
                print "    [$i] $c"
                ((i++))
            done
            print "    [0] 新しいプロジェクトを作成"
            
            print -n "  👉 番号を選択: "
            read sel

            if [[ "$sel" -gt 0 && "$sel" -le "${#choices}" ]]; then
                TARGET_PROJECT_DIR="${existing_dirs[$sel]}"
            else
                IS_NEW_PROJECT=true
            fi
        else
            print "  🆕 新規作成"
            IS_NEW_PROJECT=true
        fi

        if $IS_NEW_PROJECT; then
            print -n "  🏷  タイトルを入力: "
            read USER_TITLE
            TITLE="${USER_TITLE:-$DEFAULT_TITLE}"

            # Select tier for new project
            SELECTED_TIER=$(select_tier)
            TIER_PATH="$FOOTAGE_ROOT/$SELECTED_TIER"

            # Create tier folder if it doesn't exist
            if [[ ! -d "$TIER_PATH" ]]; then
                print "  📁 Tierフォルダを作成: $SELECTED_TIER"
                mkdir -p "$TIER_PATH"
            fi

            BASE_DIR="${TIER_PATH}/${TARGET_DATE}-${TITLE}"
            TARGET_PROJECT_DIR="$BASE_DIR"

            count=1
            while [[ -e "$TARGET_PROJECT_DIR" ]]; do
                TARGET_PROJECT_DIR="${BASE_DIR}-${count}"
                count=$((count + 1))
            done

            mkdir -p "$TARGET_PROJECT_DIR"
            [[ -d "$TEMPLATE_DIR" ]] && cp -R "$TEMPLATE_DIR"/. "$TARGET_PROJECT_DIR"
            [[ -d "$ASSETS_DIR" ]] && ln -s "$ASSETS_DIR" "$TARGET_PROJECT_DIR/Assets" 2>/dev/null || true

            print "  ✅ 作成先: $SELECTED_TIER"
        fi

        # 転送先決定（ここでフォルダだけ先に準備する）
        if [[ -n "$DEST_FOLDER_NAME" ]]; then
            DEST_SUB="$TARGET_PROJECT_DIR/$DEST_FOLDER_NAME"
        else
            DEST_SUB="$TARGET_PROJECT_DIR/Footage/$DEVICE_NAME"
        fi
        
        mkdir -p "$DEST_SUB"
        project_dir_by_date[$TARGET_DATE]="$TARGET_PROJECT_DIR"
        dest_sub_by_date[$TARGET_DATE]="$DEST_SUB"
        print "  📁 準備完了: $DEST_SUB"
    done

    print "\n🚚 転送フェーズ..."
    for TARGET_DATE in $dates_sorted; do
        TARGET_PROJECT_DIR="${project_dir_by_date[$TARGET_DATE]}"
        DEST_SUB="${dest_sub_by_date[$TARGET_DATE]}"
        print "\n  🚀 [ $DEVICE_NAME ] $TARGET_DATE -> $DEST_SUB"

        # ソースディレクトリを再スキャンして、TARGET_DATEに一致するファイルのみ転送
        count_done=0
        for f in "$SOURCE_DIR"/*; do
            [[ -f "$f" ]] || continue
            fname=$(basename "$f")

            # 履歴チェック
            history_key="${DEVICE_NAME}:${fname}"
            if [[ -n "${imported_files[$history_key]}" ]]; then
                continue
            fi

            # 除外パターンチェック
            skip_file=false
            for pat in $EXCLUDE_PATTERNS; do
                if [[ "$fname" == ${~pat} ]]; then
                    skip_file=true
                    break
                fi
            done
            $skip_file && continue

            # 日付・時刻抽出
            dpart=""
            tpart=""
            if [[ "$fname" =~ $DATE_REGEX ]]; then
                dpart="$match[1]"
                tpart="$match[2]"
            fi

            if [[ -n "$dpart" && "$dpart" =~ ^[0-9]{8}$ && -n "$tpart" && "$tpart" =~ ^[0-9]{6}$ ]]; then
                formatted_date=$(calculate_shooting_date "$dpart" "$tpart")

                # この日付がTARGET_DATEと一致する場合のみ転送
                if [[ "$formatted_date" == "$TARGET_DATE" ]]; then
                    if rsync -a --progress "$f" "$DEST_SUB/"; then
                        echo "${DEVICE_NAME}:${fname}" >> "$HISTORY_FILE"
                        ((count_done++)) || true
                    else
                        print "⚠️ 転送失敗: $fname"
                    fi
                fi
            fi
        done

        print "  ✅ 完了 ($count_done ファイル)"
        open "$TARGET_PROJECT_DIR" || true
    done

done

print "\n🎉 全処理完了！"
