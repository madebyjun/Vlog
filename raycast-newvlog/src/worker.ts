// 転送ワーカー: Raycast から切り離されたプロセスとして転送エンジンを実行する。
// 使い方: node worker.js <ジョブディレクトリ>
// esbuild で assets/worker.js にバンドルされる (npm run build:worker)。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { RunState, TransferRun } from "./lib/engine";
import { JobStateFile, parseSpec, writeFileAtomicSync } from "./lib/job";
import { formatGib } from "./lib/format";

const WRITE_INTERVAL_MS = 250;

const dir = process.argv[2];
if (!dir) {
  console.error("usage: worker.js <job-dir>");
  process.exit(2);
}
const statePath = path.join(dir, "state.json");
const spec = parseSpec(fs.readFileSync(path.join(dir, "spec.json"), "utf8"));

let latest: RunState | undefined;
let timer: NodeJS.Timeout | undefined;

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!latest) return;
  const file: JobStateFile = { pid: process.pid, updatedAt: Date.now(), state: latest };
  try {
    writeFileAtomicSync(statePath, JSON.stringify(file));
  } catch (error) {
    console.error("state.json を書き込めませんでした:", error);
  }
}

function onState(state: RunState): void {
  latest = state;
  // 終了時は即時、それ以外は間引いて書く
  if (state.phase !== "running") flush();
  else if (!timer) timer = setTimeout(flush, WRITE_INTERVAL_MS);
}

const approved = new Set(spec.approvedSpaceDevices);
const transfer = new TransferRun(spec.input, {
  // UI がいないので、開始前に承認済みかどうかで判断する。
  // 見積もりではマージン内に収まっていたが実際は足りなかった場合 (マージンのみ不足) はそのまま続行し、
  // 転送サイズ自体が入らない場合だけ中止する。
  confirmSpace: async (info) => approved.has(info.deviceName) || !info.insufficient,
});

transfer.subscribe(onState);

// 中止要求 (UI の「転送を中止」から SIGTERM が届く)
process.on("SIGTERM", () => transfer.cancel());
process.on("SIGINT", () => transfer.cancel());
process.on("SIGHUP", () => {});

// 想定外の例外でも「実行中」のまま残さない
function failHard(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  if (latest) {
    latest = {
      ...latest,
      phase: "aborted",
      fatalError: `転送ワーカーで予期しないエラーが発生しました: ${message}`,
      finishedAt: Date.now(),
    };
    flush();
  }
  process.exit(1);
}
process.on("uncaughtException", failHard);
process.on("unhandledRejection", failHard);

// 転送中のスリープを防ぐ (このプロセスが終了すると caffeinate も終了する)
const caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], {
  stdio: "ignore",
  detached: true,
});
caffeinate.on("error", () => {});
caffeinate.unref();

function notify(state: RunState): void {
  if (!spec.notify) return;
  const title = "New Vlog Import";
  const message =
    state.phase === "aborted"
      ? `🛑 中断しました${state.fatalError ? `: ${state.fatalError}` : ""}`
      : state.failed.length > 0
        ? `⚠️ 完了 (失敗 ${state.failed.length}件) ${state.doneFiles}/${state.totalFiles} ファイル`
        : `🎉 転送完了 ${state.doneFiles} ファイル / ${formatGib(state.doneBytes)}`;
  // 文字列は argv で渡してスクリプトに埋め込まない
  const child = spawn(
    "/usr/bin/osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
    ].concat([message, title]),
    { stdio: "ignore" },
  );
  child.on("error", () => {});
}

transfer.start().then(() => {
  flush();
  if (latest) notify(latest);
  // 通知コマンドの起動を待ってから終了する
  setTimeout(() => process.exit(0), 500);
}, failHard);
