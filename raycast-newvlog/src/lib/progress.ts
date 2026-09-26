// 転送の進捗・速度・残り時間の計算 (転送画面・メニューバー・履歴で共通)
import type { RunState } from "./engine";

export interface ProgressStats {
  /** 0〜1 */
  ratio: number;
  /** 処理済み (成功 + 失敗 + 転送中のファイルの途中まで) */
  processedBytes: number;
  totalBytes: number;
  /** バイト/秒。まだ計算できなければ undefined */
  bytesPerSec?: number;
  /** 残り時間 (ms)。転送中で速度が出ているときだけ */
  etaMs?: number;
  elapsedMs: number;
}

/** 速度を出すのに必要な最短の計測時間 (転送開始直後の極端な値を避ける) */
const MIN_SAMPLE_MS = 2000;

export function progressStats(state: RunState, now = Date.now()): ProgressStats {
  const current = state.groups.reduce((s, g) => s + (g.status === "transferring" ? (g.currentFileBytes ?? 0) : 0), 0);
  const processedBytes = state.doneBytes + (state.failedBytes ?? 0) + current;
  const totalBytes = state.totalBytes;

  let ratio: number;
  if (state.phase === "finished") ratio = 1;
  else if (totalBytes > 0) ratio = processedBytes / totalBytes;
  else ratio = state.totalFiles > 0 ? state.doneFiles / state.totalFiles : 0;
  ratio = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));

  const end = state.finishedAt ?? now;
  const elapsedMs = Math.max(0, end - state.startedAt);

  let bytesPerSec: number | undefined;
  let etaMs: number | undefined;
  if (state.transferStartedAt !== undefined) {
    const spanMs = end - state.transferStartedAt;
    if (spanMs >= MIN_SAMPLE_MS && processedBytes > 0) {
      bytesPerSec = processedBytes / (spanMs / 1000);
      if (state.phase === "running") {
        etaMs = (Math.max(0, totalBytes - processedBytes) / bytesPerSec) * 1000;
      }
    }
  }
  return { ratio, processedBytes, totalBytes, bytesPerSec, etaMs, elapsedMs };
}
