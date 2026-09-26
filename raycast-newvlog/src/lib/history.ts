// 過去の取り込み結果の読み込み (履歴画面用)。
// ワーカーが終了時にログ (newvlog-*.log) と並べて書く要約 (newvlog-*.json) を読む。
import * as fs from "node:fs/promises";
import path from "node:path";
import type { RunSummary } from "./engine";

export type HistoryEntry =
  | { kind: "run"; id: string; startedAt: number; summary: RunSummary; logFile?: string }
  /** 要約が無い古いログ */
  | { kind: "legacy"; id: string; startedAt: number; logFile: string };

/** newvlog-YYYYMMDD-HHMMSS (UTC) → epoch ms */
function stampToTime(name: string): number | undefined {
  const m = /^newvlog-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\./.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function isSummary(value: unknown): value is RunSummary {
  const v = value as Partial<RunSummary> | null;
  return (
    !!v &&
    typeof v === "object" &&
    v.version === 1 &&
    typeof v.startedAt === "number" &&
    Array.isArray(v.groups) &&
    Array.isArray(v.failed)
  );
}

/** 新しい順に返す。読めないファイルは無視する */
export async function readHistory(logDir: string): Promise<HistoryEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  const summarized = new Set<string>();

  for (const name of names.filter((n) => n.startsWith("newvlog-") && n.endsWith(".json"))) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(logDir, name), "utf8"));
      if (!isSummary(parsed)) continue;
      const base = name.slice(0, -".json".length);
      const logFile = path.join(logDir, `${base}.log`);
      summarized.add(`${base}.log`);
      entries.push({
        kind: "run",
        id: base,
        startedAt: parsed.startedAt,
        summary: parsed,
        logFile: parsed.logFile ?? logFile,
      });
    } catch {
      // 壊れた要約は表示しない (ログがあれば旧形式として出る)
    }
  }
  for (const name of names.filter((n) => n.startsWith("newvlog-") && n.endsWith(".log"))) {
    if (summarized.has(name)) continue;
    const startedAt = stampToTime(name);
    if (startedAt === undefined) continue;
    entries.push({ kind: "legacy", id: name, startedAt, logFile: path.join(logDir, name) });
  }
  return entries.sort((a, b) => b.startedAt - a.startedAt);
}
