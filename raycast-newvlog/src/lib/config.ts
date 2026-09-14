// newvlog.sh の「0. 設定エリア」に相当する定数群

// --- SSD設定 (マウントポイントからの相対パス) ---
export const SSD_SUBPATH = "001 Camera/Footage";
export const TEMPLATE_SUBPATH = "001 Camera/_Template";
export const ASSETS_SUBPATH = "001 Camera/_Assets";
export const HISTORY_FILENAME = ".import_history";

// --- Tier folders ---
export const TIER_FOLDERS = ["TIER_1__KEEP", "TIER_2__STORE", "TIER_3__TEMP"] as const;
export type Tier = (typeof TIER_FOLDERS)[number];

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  TIER_1__KEEP: "重要保管素材 - 重要プロジェクト",
  TIER_2__STORE: "通常保管素材 - 通常プロジェクト",
  TIER_3__TEMP: "一時保存素材 - テスト撮影・草稿",
};

// --- 除外設定 (zsh のグロブパターン) ---
export const EXCLUDE_PATTERNS = ["*.LRF"];

// --- デバイス検出ルール ---
// UUIDではなく、ボリューム内のフォルダ構成で自動検出します。
// 同じ検出フォルダを持つデバイスが複数見つかった場合、発見順に destDirs を割り当てます。
export interface DeviceRule {
  /** デバイス名の接頭辞 (履歴キー "名前_N:ファイル名" にも使われるため変更注意) */
  namePrefix: string;
  /** 検出用フォルダ (ボリュームルートからの相対パス) */
  detectPath: string;
  /** ファイル読み込み元 (ボリュームルートからの相対パス) */
  sourcePath: string;
  /** 転送先フォルダ名 (複数台ある場合は発見順に割り当て) */
  destDirs: string[];
  /** 日付(YYYYMMDD)・時刻(HHMMSS) 抽出用の正規表現 (キャプチャ1=日付, 2=時刻) */
  dateRegex: RegExp;
}

export const DEVICE_RULES: DeviceRule[] = [
  // [1] Osmo Action  例: DJI_20251019114536_0001_D.MP4
  {
    namePrefix: "OsmoAction",
    detectPath: "DCIM/DJI_001",
    sourcePath: "DCIM/DJI_001",
    destDirs: ["DJI_001"],
    dateRegex: /DJI_([0-9]{8})([0-9]{6})/,
  },
  // [2] DJI Mic (最大2台)  例: DJI_29_20251017_175848.WAV
  {
    namePrefix: "DJI_Mic",
    detectPath: "DJI_Audio_001",
    sourcePath: "DJI_Audio_001",
    destDirs: ["DJI_Audio_001", "DJI_Audio_002"],
    dateRegex: /DJI_[0-9]+_([0-9]{8})_([0-9]{6})/,
  },
];
