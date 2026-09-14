const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * ファイルの撮影日を計算する (スクリプトの calculate_shooting_date 相当)
 * @param rawDate YYYYMMDD
 * @param rawTime HHMMSS
 * @param cutoffHHMM 切り替え時刻 (HHMM)。この時刻より前は前日扱い
 * @returns YYYY-MM-DD。入力が不正なら null
 */
export function calculateShootingDate(rawDate: string, rawTime: string, cutoffHHMM: string): string | null {
  if (!/^[0-9]{8}$/.test(rawDate) || !/^[0-9]{6}$/.test(rawTime)) {
    return null;
  }

  const formatted = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  const fileHHMM = rawTime.slice(0, 4);

  // 切り替え時刻以降はそのまま
  if (Number(fileHHMM) >= Number(cutoffHHMM)) {
    return formatted;
  }

  // 切り替え時刻より前 → 前日として扱う
  const y = Number(rawDate.slice(0, 4));
  const m = Number(rawDate.slice(4, 6));
  const d = Number(rawDate.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    // 暦上存在しない日付 (スクリプトでは date コマンド失敗時にそのまま返す)
    return formatted;
  }
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
