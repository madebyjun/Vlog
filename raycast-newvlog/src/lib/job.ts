// バックグラウンド転送ジョブの管理。
// 転送は Raycast から切り離したワーカープロセス (worker.ts) で実行し、
// 進捗はジョブディレクトリの state.json を介して UI に伝える。
// (Raycast を閉じても転送は続き、開き直すと state.json から進捗を再表示する)
//
// UI・ワーカー・E2E から共通で使うため、@raycast/api には依存しないこと。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import type { RunInput, RunState } from "./engine";
import { run } from "./shell";

export interface JobPaths {
  dir: string;
  /** 転送内容 (UI → ワーカー) */
  spec: string;
  /** 進捗 (ワーカー → UI) */
  state: string;
  /** ワーカーの PID */
  pid: string;
  /** ワーカーの stdout/stderr */
  workerLog: string;
  /** 起動・片付けの排他ロック (ジョブディレクトリごと消すので外に置く) */
  lock: string;
}

export function jobPaths(supportPath: string): JobPaths {
  const dir = path.join(supportPath, "job");
  return {
    dir,
    spec: path.join(dir, "spec.json"),
    state: path.join(dir, "state.json"),
    pid: path.join(dir, "worker.pid"),
    workerLog: path.join(dir, "worker.log"),
    lock: path.join(supportPath, "job.lock"),
  };
}

export interface JobSpec {
  input: RunInput;
  /** 開始前に UI で「容量不足だがこのまま転送」を承認したデバイス名 */
  approvedSpaceDevices: string[];
  /** 完了時に macOS 通知を出すか */
  notify: boolean;
}

export interface JobStateFile {
  pid: number;
  updatedAt: number;
  state: RunState;
}

export type JobStatus =
  | { kind: "none" }
  /** ワーカー起動直後で、まだ進捗が書かれていない */
  | { kind: "starting" }
  | { kind: "running"; state: RunState }
  | { kind: "finished"; state: RunState }
  /** ワーカーが完了を書かずに消えた (強制終了・クラッシュ等) */
  | { kind: "crashed"; state?: RunState };

// ---------- シリアライズ ----------
// RunInput には Set (ctx.imported) と RegExp (device.dateRegex) が含まれるため、JSON 用に変換する

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { __set: [...value] };
  if (value instanceof RegExp) return { __regexp: value.source, flags: value.flags };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as { __set?: unknown[]; __regexp?: string; flags?: string };
    if (Array.isArray(v.__set)) return new Set(v.__set);
    if (typeof v.__regexp === "string") return new RegExp(v.__regexp, v.flags ?? "");
  }
  return value;
}

export function serializeSpec(spec: JobSpec): string {
  // 履歴全件はワーカーでは不要 (エンジンは追記するだけ) なので空にして渡す
  const input = { ...spec.input, ctx: { ...spec.input.ctx, imported: new Set<string>() } };
  return JSON.stringify({ ...spec, input }, replacer);
}

export function parseSpec(text: string): JobSpec {
  return JSON.parse(text, reviver) as JobSpec;
}

/** 一時ファイルに書いてから rename する (読み手が書きかけの JSON を見ないように) */
export function writeFileAtomicSync(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

// ---------- 状態の読み取り ----------

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function readPid(paths: JobPaths): Promise<number | undefined> {
  const text = await readText(paths.pid);
  const pid = Number(text?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * PID のプロセスが「このジョブのワーカー」として生きているか。
 * PID の再利用で別プロセスを誤判定しないよう、コマンドラインにジョブディレクトリが含まれるかも照合する。
 */
export async function isWorkerAlive(pid: number, paths: JobPaths): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH = 存在しない / EPERM = 他ユーザーのプロセス (= 自分のワーカーではない)
    return false;
  }
  try {
    const { stdout } = await run("/bin/ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(paths.dir);
  } catch {
    return false;
  }
}

export async function readJob(paths: JobPaths): Promise<JobStatus> {
  const pid = await readPid(paths);
  if (pid === undefined) return { kind: "none" };

  const text = await readText(paths.state);
  let file: JobStateFile | undefined;
  if (text) {
    try {
      file = JSON.parse(text) as JobStateFile;
    } catch {
      file = undefined;
    }
  }

  if (file && file.state.phase !== "running") return { kind: "finished", state: file.state };

  const alive = await isWorkerAlive(pid, paths);
  if (!alive) {
    // 終了直前の最終書き込みと生存確認が競合した場合に備えて読み直す
    const again = await readText(paths.state);
    if (again) {
      try {
        const latest = JSON.parse(again) as JobStateFile;
        if (latest.state.phase !== "running") return { kind: "finished", state: latest.state };
        file = latest;
      } catch {
        // 読めなければ手元の値で判定する
      }
    }
    return { kind: "crashed", state: file?.state };
  }
  if (!file) return { kind: "starting" };
  return { kind: "running", state: file.state };
}

// ---------- 排他制御 ----------

/** macOS の <fcntl.h> の O_EXLOCK (Node の fs.constants には定義がない) */
const O_EXLOCK = 0x20;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

/**
 * ジョブの起動・片付けを排他的に実行する。
 * O_EXLOCK は flock 相当のカーネルロックで、同一プロセス内の別 open とも競合し、
 * 保持プロセスが死ねば OS が解放する (ロックファイルが残っても次回の取得を妨げない)。
 */
async function withJobLock<T>(paths: JobPaths, fn: () => Promise<T>): Promise<T> {
  await fsp.mkdir(path.dirname(paths.lock), { recursive: true });
  const { O_RDWR, O_CREAT, O_NONBLOCK } = fs.constants;
  const until = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(paths.lock, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
      if (Date.now() > until) {
        throw new Error("別の転送の開始処理が終わりません。しばらく待ってから再実行してください。");
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 操作 ----------

export interface StartJobOptions {
  paths: JobPaths;
  /** バンドル済みワーカー (assets/worker.js) */
  workerScript: string;
  /** ワーカーを動かす node バイナリ */
  nodePath: string;
  spec: JobSpec;
  /** ワーカーに追加で渡す環境変数 (E2E 用) */
  env?: Record<string, string>;
}

/**
 * ワーカーを切り離して起動する。起動を確認したら戻る (転送の完了は待たない)。
 * 同時に呼ばれても、ロックの中で既存ジョブを確認するので起動されるのは 1 つだけ。
 */
export function startJob(options: StartJobOptions): Promise<number> {
  return withJobLock(options.paths, () => startJobLocked(options));
}

async function startJobLocked(options: StartJobOptions): Promise<number> {
  const { paths, workerScript, nodePath, spec } = options;

  const current = await readJob(paths);
  if (current.kind === "starting" || current.kind === "running") {
    throw new Error("転送がすでに実行中です。");
  }
  if (!fs.existsSync(workerScript)) {
    throw new Error(`転送ワーカーが見つかりません: ${workerScript} (npm run build:worker を実行してください)`);
  }

  await fsp.rm(paths.dir, { recursive: true, force: true });
  await fsp.mkdir(paths.dir, { recursive: true });
  writeFileAtomicSync(paths.spec, serializeSpec(spec));

  // stdio を親 (Raycast) に繋ぐと、親の終了時に書き込みエラーで落ちるためファイルへ向ける
  const logFd = fs.openSync(paths.workerLog, "a");
  try {
    const child = spawn(nodePath, [workerScript, paths.dir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env, ...options.env },
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new Error(`転送ワーカーを起動できませんでした: ${error.message}`)));
    });
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("転送ワーカーの PID を取得できませんでした。");
    writeFileAtomicSync(paths.pid, `${pid}\n`);
    return pid;
  } finally {
    fs.closeSync(logFd);
  }
}

/** 中止を要求する (ワーカーが SIGTERM を受けて転送中のファイルを停止する) */
export async function cancelJob(paths: JobPaths): Promise<boolean> {
  const pid = await readPid(paths);
  if (pid === undefined || !(await isWorkerAlive(pid, paths))) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** 終了済みのジョブを片付ける。実行中なら false */
export function clearJob(paths: JobPaths): Promise<boolean> {
  return withJobLock(paths, async () => {
    const status = await readJob(paths);
    if (status.kind === "starting" || status.kind === "running") return false;
    await fsp.rm(paths.dir, { recursive: true, force: true });
    return true;
  });
}
