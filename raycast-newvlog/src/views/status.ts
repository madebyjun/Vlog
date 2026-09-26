// 転送状態の表示 (転送画面・メニューバー・履歴で共通)
import { Color, Icon, Image } from "@raycast/api";
import { getProgressIcon } from "@raycast/utils";
import { useEffect, useState } from "react";
import type { GroupProgress, RunState } from "../lib/engine";
import { JobPaths, JobStatus, readJob } from "../lib/job";

export const CRASHED_MESSAGE =
  "転送プロセスが途中で終了しました (強制終了・再起動など)。再実行すれば未転送のファイルだけ転送されます。";

/** 異常終了したジョブは「中断」として表示する */
export function displayState(status: JobStatus): RunState | undefined {
  if (status.kind === "running" || status.kind === "finished") return status.state;
  if (status.kind === "crashed" && status.state) {
    return {
      ...status.state,
      phase: "aborted",
      fatalError: CRASHED_MESSAGE,
      finishedAt: status.state.finishedAt ?? Date.now(),
      groups: status.state.groups.map((g) =>
        g.status === "transferring" || g.status === "preparing"
          ? { ...g, status: "failed", currentFile: undefined }
          : g,
      ),
    };
  }
  return undefined;
}

/** バックグラウンドの転送ジョブの状態ファイルを定期的に読む */
export function useJobStatus(paths: JobPaths, intervalMs = 500): JobStatus | undefined {
  const [status, setStatus] = useState<JobStatus>();
  useEffect(() => {
    let active = true;
    let timer: NodeJS.Timeout | undefined;
    const poll = async () => {
      const next = await readJob(paths);
      if (!active) return;
      setStatus(next);
      // 終了後は状態が変わらないので読み直さない
      if (next.kind === "starting" || next.kind === "running") timer = setTimeout(poll, intervalMs);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [paths, intervalMs]);
  return status;
}

export function groupRatio(g: GroupProgress): number {
  if (g.status === "done") return 1;
  return g.totalBytes > 0 ? Math.min(1, (g.doneBytes + (g.currentFileBytes ?? 0)) / g.totalBytes) : 0;
}

export function groupIcon(g: GroupProgress): Image.ImageLike {
  switch (g.status) {
    case "pending":
    case "ready":
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
    case "skipped":
      return { source: Icon.MinusCircle, tintColor: Color.SecondaryText };
    case "preparing":
      return { source: Icon.CircleEllipsis, tintColor: Color.Blue };
    case "transferring":
      return getProgressIcon(groupRatio(g), Color.Blue);
    case "done":
      return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "partial":
      return { source: Icon.Warning, tintColor: Color.Orange };
    case "failed":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
  }
}

export function groupLabel(status: GroupProgress["status"]): string {
  switch (status) {
    case "pending":
      return "待機中";
    case "skipped":
      return "スキップ";
    case "preparing":
      return "フォルダ準備中";
    case "ready":
      return "転送待ち";
    case "transferring":
      return "転送中";
    case "done":
      return "完了";
    case "partial":
      return "一部失敗";
    case "failed":
      return "中断";
  }
}

export type Outcome = "running" | "success" | "partial" | "aborted";

export function outcomeOf(state: Pick<RunState, "phase" | "failed">): Outcome {
  if (state.phase === "running") return "running";
  if (state.phase === "aborted") return "aborted";
  return state.failed.length > 0 ? "partial" : "success";
}

export const OUTCOME: Record<Outcome, { label: string; color: Color; icon: Icon }> = {
  running: { label: "転送中", color: Color.Blue, icon: Icon.ArrowClockwise },
  success: { label: "完了", color: Color.Green, icon: Icon.CheckCircle },
  partial: { label: "一部失敗", color: Color.Orange, icon: Icon.Warning },
  aborted: { label: "中断", color: Color.Red, icon: Icon.XMarkCircle },
};

/** プロジェクトフォルダ (重複なし) */
export function projectDirsOf(state: Pick<RunState, "groups">): string[] {
  return [...new Set(state.groups.map((g) => g.projectDir).filter((p): p is string => Boolean(p)))];
}
