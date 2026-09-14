import { getPreferenceValues } from "@raycast/api";

interface PreferenceValues {
  ssdUuid: string;
  cutoffTime?: string;
  spaceMarginGb?: string;
  defaultTitle?: string;
  openInFinder?: boolean;
}

export interface Settings {
  ssdUuid: string;
  /** "HH:MM" */
  cutoffTime: string;
  /** "HHMM" (比較用) */
  cutoffHHMM: string;
  spaceMarginGb: number;
  spaceMarginBytes: number;
  defaultTitle: string;
  openInFinder: boolean;
}

/** Raycast の Preferences を読み込み、スクリプトの設定値に変換する */
export function loadSettings(): Settings {
  const p = getPreferenceValues<PreferenceValues>();

  const ssdUuid = (p.ssdUuid ?? "").trim();
  if (!ssdUuid) {
    throw new Error("SSD_UUID が未設定です。拡張機能の設定 (Preferences) で SSD UUID を指定してください。");
  }

  const cutoffTime = (p.cutoffTime ?? "").trim() || "04:00";
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(cutoffTime)) {
    throw new Error(`日付切り替え時刻の形式が不正です: "${cutoffTime}" (HH:MM 形式で指定してください)`);
  }

  const marginRaw = (p.spaceMarginGb ?? "").trim() || "2";
  const spaceMarginGb = Number(marginRaw);
  if (!Number.isFinite(spaceMarginGb) || spaceMarginGb < 0) {
    throw new Error(`安全マージンの値が不正です: "${marginRaw}" (GB単位の数値で指定してください)`);
  }

  return {
    ssdUuid,
    cutoffTime,
    cutoffHHMM: cutoffTime.replace(":", ""),
    spaceMarginGb,
    spaceMarginBytes: Math.round(spaceMarginGb * 1024 * 1024 * 1024),
    defaultTitle: (p.defaultTitle ?? "").trim() || "NewProject",
    openInFinder: p.openInFinder ?? true,
  };
}
