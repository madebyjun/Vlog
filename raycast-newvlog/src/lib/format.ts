/** バイト数を「x.x GiB」表記に変換 (スクリプトの format_gib 相当) */
export function formatGib(bytes: number): string {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

/** 1 GiB 未満は MiB で表示する */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  return formatGib(bytes);
}

/** バイト/秒を「123 MB/s」表記にする */
export function formatSpeed(bytesPerSec: number): string {
  const mb = bytesPerSec / 1000 / 1000;
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
}

export function formatPercent(ratio: number): string {
  return `${Math.floor(ratio * 100)}%`;
}

/** 残り時間を大まかに表す (1分未満は「まもなく」) */
export function formatEta(ms: number): string {
  if (ms < 60_000) return "まもなく完了";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `残り約${minutes}分`;
  return `残り約${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** 経過ミリ秒を「1分32秒」形式にする */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** zsh のグロブ (`*`, `?`) を正規表現に変換する (除外パターン用) */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}
