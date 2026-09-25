// バックグラウンド転送の E2E。
// 偽の SSD / 偽のデバイス (Osmo Action) をサンドボックスに作り、
// 本番と同じ startJob → detached ワーカー (assets/worker.js) → rsync の経路で転送させて結果を検証する。
// 検証項目は e2e/FAILURE_MODES.md に対応する。
//
// 実行: npm run e2e   → 結果は e2e/.out/report.md に出力される

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunState, computeSpaceInfo } from "../src/lib/engine";
import { readHistory as readRunHistory } from "../src/lib/history";
import {
  JobPaths,
  JobSpec,
  JobStatus,
  cancelJob,
  clearJob,
  jobPaths,
  parseSpec,
  readJob,
  serializeSpec,
  startJob,
} from "../src/lib/job";
import { Plan, suggestPlan } from "../src/lib/plan";
import { progressStats } from "../src/lib/progress";
import { DateGroup, detectDevices, scanDevice } from "../src/lib/scan";
import {
  DEFAULT_INPUT,
  Settings,
  SettingsInput,
  loadSettingsFrom,
  saveSettingsTo,
  validateSettings,
} from "../src/lib/settings";
import type { SsdContext } from "../src/lib/ssd";

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.join(ROOT, "e2e", ".out");
const SANDBOX = path.join(OUT, "sandbox");
const WORKER = path.join(ROOT, "assets", "worker.js");
const FILES_PER_DAY = 150;
const FILE_BYTES = 64 * 1024;
const DAYS = ["20260920", "20260921"];

/** Raycast が使っている node があればそれで動かす (本番と同じ条件) */
function nodePath(): string {
  const dir = path.join(os.homedir(), "Library/Application Support/com.raycast.macos/NodeJS/runtime");
  try {
    for (const v of fs.readdirSync(dir).sort().reverse()) {
      const p = path.join(dir, v, "bin/node");
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // フォールバック
  }
  return process.execPath;
}

// ---------- 検証結果の記録 ----------

interface Check {
  scenario: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let scenario = "";
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ scenario, name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- サンドボックス ----------

interface Env {
  base: string;
  paths: JobPaths;
  ctx: SsdContext;
  settings: Settings;
  volumes: string;
  existingProject: string;
}

function makeEnv(name: string): Env {
  const base = path.join(SANDBOX, name);
  fs.rmSync(base, { recursive: true, force: true });
  const mount = path.join(base, "SSD");
  const footageRoot = path.join(mount, "001 Camera/Footage");
  const templateDir = path.join(mount, "001 Camera/_Template");
  const assetsDir = path.join(mount, "001 Camera/_Assets");
  fs.mkdirSync(footageRoot, { recursive: true });
  fs.mkdirSync(path.join(templateDir, "Edit"), { recursive: true });
  fs.writeFileSync(path.join(templateDir, "Edit/project.txt"), "template\n");
  fs.mkdirSync(assetsDir, { recursive: true });
  const historyFile = path.join(footageRoot, ".import_history");
  fs.writeFileSync(historyFile, "");

  // 2日目用の既存プロジェクト
  const existingProject = path.join(footageRoot, "TIER_2__STORE", "2026-09-21-Existing");
  fs.mkdirSync(existingProject, { recursive: true });

  // 偽の Osmo Action
  const volumes = path.join(base, "Volumes");
  const src = path.join(volumes, "OSMO", "DCIM", "DJI_001");
  fs.mkdirSync(src, { recursive: true });
  const payload = Buffer.alloc(FILE_BYTES, 7);
  let n = 1;
  for (const day of DAYS) {
    for (let i = 0; i < FILES_PER_DAY; i++) {
      const t = 100000 + Math.floor(i / 60) * 100 + (i % 60); // 10:00:00 から1秒刻み
      fs.writeFileSync(path.join(src, `DJI_${day}${t}_${String(n).padStart(4, "0")}_D.MP4`), payload);
      n += 1;
    }
  }
  fs.writeFileSync(path.join(src, "DJI_20260920100000_0001_D.LRF"), "excluded");

  return {
    base,
    paths: jobPaths(path.join(base, "support")),
    ctx: {
      uuid: "E2E",
      mount,
      footageRoot,
      templateDir,
      assetsDir,
      historyFile,
      imported: new Set(),
      historyCount: 0,
    },
    settings: {
      ssdUuid: "E2E",
      cutoffTime: "04:00",
      cutoffHHMM: "0400",
      spaceMarginGb: 0,
      spaceMarginBytes: 0,
      defaultTitle: "NewProject",
      defaultTier: "TIER_2__STORE",
      excludePatterns: ["*.LRF"],
      openInFinder: false,
      notify: false,
    },
    volumes,
    existingProject,
  };
}

function readHistory(env: Env): string[] {
  return fs.readFileSync(env.ctx.historyFile, "utf8").split("\n").filter(Boolean);
}

async function scan(env: Env): Promise<{ groups: DateGroup[]; spec: JobSpec }> {
  env.ctx.imported = new Set(readHistory(env));
  const devices = await detectDevices(env.ctx.mount, env.volumes);
  const groups: DateGroup[] = [];
  for (const d of devices) groups.push(...(await scanDevice(d, env.ctx, env.settings)));
  const plans: Record<string, Plan> = {};
  for (const g of groups) {
    plans[g.id] =
      g.date === "2026-09-20"
        ? { kind: "new", title: "E2E", tier: "TIER_3__TEMP" }
        : { kind: "existing", projectDir: env.existingProject, projectName: path.basename(env.existingProject) };
  }
  return {
    groups,
    spec: {
      input: {
        ctx: env.ctx,
        settings: env.settings,
        devices,
        groups,
        plans,
        logDir: path.join(env.base, "support", "logs"),
      },
      approvedSpaceDevices: [],
      notify: false,
    },
  };
}

/** Raycast 役の親プロセスから起動し、親は起動直後に SIGKILL で死ぬ (ウィンドウを閉じた状態の再現) */
async function startFromDyingParent(env: Env, spec: JobSpec): Promise<void> {
  const specFile = path.join(env.base, "launch-spec.json");
  fs.writeFileSync(specFile, serializeSpec(spec));
  const parent = spawn(process.execPath, [__filename, "--launcher", env.paths.dir, specFile, WORKER, nodePath()], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const exit = await new Promise<NodeJS.Signals | number | null>((resolve) =>
    parent.on("exit", (code, signal) => resolve(signal ?? code)),
  );
  check("親プロセスは起動直後に強制終了した", exit === "SIGKILL", `exit=${String(exit)}`);
}

async function waitFor(
  env: Env,
  pred: (s: JobStatus) => boolean,
  timeoutMs = 60_000,
  onTick?: () => void,
): Promise<JobStatus> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    onTick?.();
    const s = await readJob(env.paths);
    if (pred(s)) return s;
    if (Date.now() > until) throw new Error(`timeout: last=${JSON.stringify(s).slice(0, 200)}`);
    await sleep(20);
  }
}

function workerPid(env: Env): number {
  return Number(fs.readFileSync(env.paths.pid, "utf8").trim());
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 条件が満たされるまで待つ (最大 timeoutMs) */
async function eventually(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

function caffeinateFor(pid: number): boolean {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
    return out.split("\n").some((l) => l.includes("caffeinate") && l.includes(`-w ${pid}`));
  } catch {
    return false;
  }
}

/** 履歴に載っているファイルは、すべて転送先に完全なサイズで存在するか */
function historyMatchesDisk(env: Env, destOf: (file: string) => string): boolean {
  return readHistory(env).every((line) => {
    const name = line.split(":")[1];
    try {
      return fs.statSync(path.join(destOf(name), name)).size === FILE_BYTES;
    } catch {
      return false;
    }
  });
}

// ---------- シナリオ ----------

async function scenarioHappyPath(): Promise<void> {
  scenario = "A. 親が死んでも最後まで転送される";
  console.log(`\n${scenario}`);
  const env = makeEnv("a-happy");
  const { spec } = await scan(env);
  const total = FILES_PER_DAY * DAYS.length;

  const bundle = fs.readFileSync(WORKER, "utf8");
  check("ワーカーのバンドルが @raycast/api を読み込まない", !bundle.includes('require("@raycast/api")'));

  await startFromDyingParent(env, spec);
  const pid = workerPid(env);

  // 状態ファイルを高頻度で直接読み、壊れた JSON を観測しないか確認
  let reads = 0;
  let parseErrors = 0;
  let sawCaffeinate = false;
  const tick = () => {
    try {
      JSON.parse(fs.readFileSync(env.paths.state, "utf8"));
      reads += 1;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") parseErrors += 1;
    }
    if (!sawCaffeinate) sawCaffeinate = caffeinateFor(pid);
  };
  const running = await waitFor(env, (s) => s.kind === "running" || s.kind === "finished", 10_000, tick);
  check("親の死後もワーカーが生きて進捗を書いている", running.kind === "running", running.kind);
  const done = await waitFor(env, (s) => s.kind !== "running" && s.kind !== "starting", 120_000, tick);
  check(
    "状態を読み続けても壊れた JSON を観測しない",
    parseErrors === 0,
    `${reads}回読み取り / パース失敗 ${parseErrors}`,
  );
  check("caffeinate がワーカーを監視して動いていた", sawCaffeinate);

  const state = done.kind === "finished" ? done.state : undefined;
  check("ジョブが finished で終わる", done.kind === "finished" && state?.phase === "finished", done.kind);
  check("全ファイル転送済み", state?.doneFiles === total && state?.failed.length === 0, `${state?.doneFiles}/${total}`);
  check("履歴に全ファイルが記録された", readHistory(env).length === total, `${readHistory(env).length}行`);

  const newProject = path.join(env.ctx.footageRoot, "TIER_3__TEMP", "2026-09-20-E2E");
  const newDest = path.join(newProject, "DJI_001");
  const existDest = path.join(env.existingProject, "DJI_001");
  check(
    "新規プロジェクトに1日目が入った",
    fs.readdirSync(newDest).filter((f) => f.endsWith(".MP4")).length === FILES_PER_DAY,
  );
  check(
    "既存プロジェクトに2日目が入った",
    fs.readdirSync(existDest).filter((f) => f.endsWith(".MP4")).length === FILES_PER_DAY,
  );
  check("テンプレートがコピーされた", fs.existsSync(path.join(newProject, "Edit/project.txt")));
  check("Assets リンクが作られた", fs.lstatSync(path.join(newProject, "Assets")).isSymbolicLink());
  check("除外パターン (.LRF) は転送されない", !fs.readdirSync(newDest).some((f) => f.endsWith(".LRF")));
  check("ワーカーは終了後に自分で終了する", await eventually(() => !processExists(pid)));
  check("caffeinate もワーカーと一緒に終了した", await eventually(() => !caffeinateFor(pid)));
  check("ログファイルが保存された", Boolean(state?.logFile && fs.existsSync(state.logFile)), state?.logFile ?? "");

  const history = await readRunHistory(path.join(env.base, "support", "logs"));
  const entry = history[0];
  check(
    "[#23] 完了したジョブの要約が履歴として読める",
    history.length === 1 &&
      entry.kind === "run" &&
      entry.summary.phase === "finished" &&
      entry.summary.doneFiles === total,
    `${history.length}件 / ${entry?.kind}`,
  );
  check(
    "[#23] 要約にプロジェクトと保存先SSDが記録される",
    entry?.kind === "run" &&
      entry.summary.ssdMount === env.ctx.mount &&
      entry.summary.groups.every((g) => Boolean(g.projectDir)) &&
      !("log" in entry.summary),
  );
}

async function scenarioDoubleStartAndCancel(): Promise<void> {
  scenario = "B. 二重起動の拒否と中止";
  console.log(`\n${scenario}`);
  const env = makeEnv("b-cancel");
  const { spec } = await scan(env);
  await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
  await waitFor(env, (s) => s.kind === "running" && s.state.doneFiles >= 5);

  let rejected = "";
  try {
    await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
  } catch (e) {
    rejected = (e as Error).message;
  }
  check("実行中の二重起動は拒否される", rejected.includes("実行中"), rejected);
  check("[#27] 実行中のジョブは clearJob で消せない", (await clearJob(env.paths)) === false);
  check("[#27] clearJob を拒否した後もジョブは実行中のまま", (await readJob(env.paths)).kind === "running");

  const pid = workerPid(env);
  check("cancelJob が SIGTERM を送れた", await cancelJob(env.paths));
  const done = await waitFor(env, (s) => s.kind !== "running");
  const state = done.kind === "finished" ? done.state : undefined;
  check("中止後は aborted で終わる", state?.phase === "aborted", `${done.kind}/${state?.phase}`);
  check("途中までで止まった", (state?.doneFiles ?? 0) < FILES_PER_DAY * DAYS.length, `${state?.doneFiles}件転送`);
  check(
    "履歴の件数 = 転送済み件数 (中止したファイルは記録されない)",
    readHistory(env).length === state?.doneFiles,
    `履歴${readHistory(env).length} / 転送${state?.doneFiles}`,
  );
  const newDest = path.join(env.ctx.footageRoot, "TIER_3__TEMP", "2026-09-20-E2E", "DJI_001");
  check(
    "履歴にあるファイルはすべて完全なサイズで存在する",
    historyMatchesDisk(env, () => newDest),
  );
  check("ワーカーは終了後に自分で終了する", await eventually(() => !processExists(pid)));
  const rsyncLeft = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
    .split("\n")
    .some((l) => l.includes("rsync") && l.includes(env.base));
  check("rsync が残っていない", !rsyncLeft);

  const history = await readRunHistory(path.join(env.base, "support", "logs"));
  check(
    "[#23] 中止したジョブの要約も履歴に残る",
    history.length === 1 && history[0].kind === "run" && history[0].summary.phase === "aborted",
    `${history.length}件`,
  );
}

async function scenarioCrashAndResume(): Promise<void> {
  scenario = "C. ワーカーの異常終了の検出と再実行";
  console.log(`\n${scenario}`);
  const env = makeEnv("c-crash");
  const { spec } = await scan(env);
  const total = FILES_PER_DAY * DAYS.length;
  await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
  await waitFor(env, (s) => s.kind === "running" && s.state.doneFiles >= 20);
  process.kill(workerPid(env), "SIGKILL");
  await sleep(200);

  const status = await readJob(env.paths);
  check("強制終了したジョブは crashed と判定される", status.kind === "crashed", status.kind);
  check("crashed でも最後の進捗は読める", status.kind === "crashed" && (status.state?.doneFiles ?? 0) >= 20);

  // 再スキャン → 残りだけが対象になり、再実行で全件そろう
  const { groups, spec: spec2 } = await scan(env);
  const remaining = groups.reduce((s, g) => s + g.files.length, 0);
  const recorded = readHistory(env).length;
  check(
    "再スキャンでは未記録のファイルだけが対象",
    remaining === total - recorded,
    `残り${remaining} / 記録済み${recorded}`,
  );
  // 1日目は作成済みの新規プロジェクトを既存として使う (UI で「既存を使用」を選ぶのと同じ)
  const firstDay = path.join(env.ctx.footageRoot, "TIER_3__TEMP", "2026-09-20-E2E");
  for (const g of groups) {
    if (g.date === "2026-09-20")
      spec2.input.plans[g.id] = { kind: "existing", projectDir: firstDay, projectName: "2026-09-20-E2E" };
  }
  await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec: spec2 });
  const done = await waitFor(env, (s) => s.kind !== "running" && s.kind !== "starting");
  check("crashed の後に新しいジョブを起動でき、完了する", done.kind === "finished" && done.state.phase === "finished");
  check(
    "最終的に履歴が全件そろう (重複なし)",
    new Set(readHistory(env)).size === total && readHistory(env).length === total,
  );
}

async function scenarioSpace(): Promise<void> {
  scenario = "D. 容量不足の事前承認";
  console.log(`\n${scenario}`);
  for (const approved of [false, true]) {
    const env = makeEnv(approved ? "d-space-approved" : "d-space-denied");
    const { spec, groups } = await scan(env);
    // 見かけの転送サイズを巨大にして「転送サイズ自体が入らない」状態を作る
    for (const g of groups) g.totalBytes = 1e18;
    const info = computeSpaceInfo(groups[0].device.name, groups, 0, 1e12);
    if (approved) spec.approvedSpaceDevices = [groups[0].device.name];
    await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
    const done = await waitFor(env, (s) => s.kind !== "running" && s.kind !== "starting");
    const state = done.kind === "finished" ? done.state : undefined;
    if (approved) {
      check(
        "承認済みなら容量不足でも転送を続ける",
        state?.phase === "finished" && state.doneFiles > 0,
        `${state?.phase}`,
      );
    } else {
      check("見積もりで容量不足と判定される", info?.insufficient === true);
      check(
        "未承認で容量不足なら中止する",
        state?.phase === "aborted" && state.doneFiles === 0,
        `${state?.fatalError}`,
      );
    }
  }
}

// ---------- E. 同時起動の排他制御 ----------

const RACERS = 8;
const RACE_ROUNDS = 4;

interface RaceResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/** ジョブディレクトリを対象に動いているワーカーの数 */
function workersFor(env: Env): number {
  const out = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes("worker.js") && l.includes(env.paths.dir)).length;
}

/** 別プロセスの racer を RACERS 個立て、同じ時刻に一斉に startJob させる */
async function raceAcrossProcesses(env: Env, spec: JobSpec): Promise<RaceResult[]> {
  const specFile = path.join(env.base, "race-spec.json");
  fs.writeFileSync(specFile, serializeSpec(spec));
  const startAt = Date.now() + 1500; // 全プロセスの起動を待ってから同時に開始
  const procs = Array.from({ length: RACERS }, () =>
    spawn(process.execPath, [__filename, "--racer", env.paths.dir, specFile, WORKER, nodePath(), String(startAt)], {
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  return Promise.all(
    procs.map(
      (p) =>
        new Promise<RaceResult>((resolve) => {
          let out = "";
          p.stdout.on("data", (c) => (out += String(c)));
          p.on("exit", () => {
            try {
              resolve(JSON.parse(out.trim()) as RaceResult);
            } catch {
              resolve({ ok: false, error: `racer の出力を読めません: ${out}` });
            }
          });
        }),
    ),
  );
}

async function raceInProcess(env: Env, spec: JobSpec): Promise<RaceResult[]> {
  const settled = await Promise.allSettled(
    Array.from({ length: RACERS }, () =>
      startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec }),
    ),
  );
  return settled.map((r) =>
    r.status === "fulfilled" ? { ok: true, pid: r.value } : { ok: false, error: (r.reason as Error).message },
  );
}

async function scenarioConcurrentStart(): Promise<void> {
  scenario = "E. 同時起動の排他制御";
  console.log(`\n${scenario}`);
  const total = FILES_PER_DAY * DAYS.length;

  const modes: [string, (env: Env, spec: JobSpec) => Promise<RaceResult[]>][] = [
    ["別プロセス", raceAcrossProcesses],
    ["同一プロセス", raceInProcess],
  ];
  for (const [label, race] of modes) {
    for (let round = 1; round <= RACE_ROUNDS; round++) {
      const env = makeEnv(`e-race-${label === "別プロセス" ? "proc" : "inproc"}-${round}`);
      const { spec } = await scan(env);
      const results = await race(env, spec);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      const workers = workersFor(env);
      const done = await waitFor(env, (s) => s.kind !== "running" && s.kind !== "starting", 120_000);
      const history = readHistory(env);
      check(
        `${label} ×${RACERS} 同時起動 (${round}/${RACE_ROUNDS}): 起動は 1 件だけ`,
        winners.length === 1 && workers <= 1 && losers.every((r) => r.error?.includes("実行中")),
        `成功${winners.length} / 拒否${losers.length} / 稼働ワーカー${workers}${
          losers.find((r) => !r.error?.includes("実行中"))
            ? ` / 想定外: ${losers.find((r) => !r.error?.includes("実行中"))?.error}`
            : ""
        }`,
      );
      check(
        `${label} (${round}/${RACE_ROUNDS}): 転送は完了し履歴に重複がない`,
        done.kind === "finished" &&
          done.state.phase === "finished" &&
          history.length === total &&
          new Set(history).size === total,
        `${done.kind} / 履歴${history.length}行 (ユニーク${new Set(history).size})`,
      );
    }
  }

  // ロックを持ったまま死んだプロセスがいても、すぐ次の起動ができる
  {
    const env = makeEnv("e-stale-lock");
    const { spec } = await scan(env);
    const holder = spawn(process.execPath, [__filename, "--lockholder", env.paths.lock], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    let blocked = "";
    const blockedStart = startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec }).then(
      () => "started",
      (e: Error) => e.message,
    );
    await sleep(300);
    blocked = (await Promise.race([blockedStart, sleep(0).then(() => "waiting")])) as string;
    check("ロック保持中は起動が待たされる", blocked === "waiting", blocked);
    const t0 = Date.now();
    holder.kill("SIGKILL");
    const result = await blockedStart;
    check(
      "保持プロセスを SIGKILL するとロックが解放され起動できる",
      result === "started",
      `${result} (${Date.now() - t0}ms)`,
    );
    await waitFor(env, (s) => s.kind !== "running" && s.kind !== "starting", 120_000);
  }

  // 実行中のワーカーはロックを継承していない (「実行中」で即座に拒否される)
  {
    const env = makeEnv("e-inherit");
    const { spec } = await scan(env);
    await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
    await waitFor(env, (s) => s.kind === "running");
    const t0 = Date.now();
    let message = "";
    try {
      await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
    } catch (e) {
      message = (e as Error).message;
    }
    const elapsed = Date.now() - t0;
    check(
      "ワーカー実行中の起動はロック待ちせず「実行中」で拒否される",
      message.includes("実行中") && elapsed < 2000,
      `${message} (${elapsed}ms)`,
    );
    await cancelJob(env.paths);
    await waitFor(env, (s) => s.kind !== "running");
  }
}

// ---------- F. 設定ファイル ----------

async function scenarioSettings(): Promise<void> {
  scenario = "F. 設定ファイルの読み書き (#17〜#19)";
  console.log(`\n${scenario}`);
  const dir = path.join(SANDBOX, "f-settings");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");

  check("[#17] ファイルが無ければ未設定", loadSettingsFrom(file).kind === "missing");
  fs.writeFileSync(file, "{ broken");
  check("[#17] 壊れた JSON は未設定扱い (例外にならない)", loadSettingsFrom(file).kind === "missing");
  fs.writeFileSync(file, "[1,2]");
  check("[#17] オブジェクトでない JSON も未設定扱い", loadSettingsFrom(file).kind === "missing");
  fs.writeFileSync(file, JSON.stringify({ cutoffTime: "05:00" }));
  check("[#17] SSD が未選択なら未設定扱い", loadSettingsFrom(file).kind === "missing");

  fs.writeFileSync(file, JSON.stringify({ ssdUuid: "UUID-1" }));
  const partial = loadSettingsFrom(file);
  check(
    "[#17] SSD だけの設定は、他の項目が既定値で補われる",
    partial.kind === "ok" &&
      partial.settings.cutoffTime === "04:00" &&
      partial.settings.spaceMarginGb === 2 &&
      partial.settings.defaultTitle === "NewProject" &&
      partial.settings.defaultTier === "TIER_2__STORE" &&
      partial.settings.excludePatterns.join() === "*.LRF" &&
      partial.settings.openInFinder &&
      partial.settings.notify,
    JSON.stringify(partial.kind === "ok" ? partial.settings : partial),
  );

  fs.writeFileSync(file, JSON.stringify({ ssdUuid: "UUID-1", cutoffTime: "25:00", spaceMarginGb: -1 }));
  const invalid = loadSettingsFrom(file);
  check(
    "[#17] 手で壊された値は invalid として項目ごとのエラーを返す",
    invalid.kind === "invalid" && Boolean(invalid.errors.cutoffTime) && Boolean(invalid.errors.spaceMarginGb),
    invalid.kind === "invalid" ? Object.keys(invalid.errors).join(",") : invalid.kind,
  );

  const good: SettingsInput = { ...DEFAULT_INPUT, ssdUuid: "UUID-2", excludePatterns: "*.LRF, *.THM" };
  const cases: [keyof SettingsInput, Partial<SettingsInput>][] = [
    ["ssdUuid", { ssdUuid: "  " }],
    ["cutoffTime", { cutoffTime: "25:00" }],
    ["cutoffTime", { cutoffTime: "4:00" }],
    ["spaceMarginGb", { spaceMarginGb: "-1" }],
    ["spaceMarginGb", { spaceMarginGb: "abc" }],
    ["spaceMarginGb", { spaceMarginGb: "" }],
    ["defaultTitle", { defaultTitle: "a/b" }],
    ["defaultTier", { defaultTier: "TIER_9" }],
    ["excludePatterns", { excludePatterns: "*.LRF, sub/*.MP4" }],
  ];
  for (const [key, patch] of cases) {
    const result = validateSettings({ ...good, ...patch });
    check(
      `[#18] 不正な ${key} (${JSON.stringify(Object.values(patch)[0])}) は保存できず、その項目にエラーが出る`,
      !result.settings && Boolean(result.errors[key]) && Object.keys(result.errors).length === 1,
      JSON.stringify(result.errors),
    );
  }

  const valid = validateSettings(good);
  check("[#18] 正しい入力は検証を通る", Boolean(valid.settings), JSON.stringify(valid.errors));
  if (!valid.settings) return;
  saveSettingsTo(file, valid.settings);
  const reloaded = loadSettingsFrom(file);
  check(
    "[#18] 保存した設定を読み直すと同じ値になる",
    reloaded.kind === "ok" && JSON.stringify(reloaded.settings) === JSON.stringify(valid.settings),
  );
  check(
    "[#18] 空のタイトルは既定値になる",
    validateSettings({ ...good, defaultTitle: "  " }).settings?.defaultTitle === "NewProject",
  );

  // 別プロセスが保存し続ける間に読み続け、壊れた設定を一度も見ないこと
  const writer = spawn(process.execPath, [__filename, "--settings-writer", file], { stdio: "ignore" });
  let reads = 0;
  let bad = 0;
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    const r = loadSettingsFrom(file);
    reads += 1;
    if (r.kind !== "ok") bad += 1;
    if (reads % 50 === 0) await sleep(1);
  }
  writer.kill("SIGKILL");
  check("[#19] 保存中に読んでも常に有効な設定が読める", bad === 0 && reads > 100, `${reads}回中 ${bad}回失敗`);
}

// ---------- G. 除外パターン ----------

async function scenarioExcludePatterns(): Promise<void> {
  scenario = "G. 除外パターンの設定がスキャンに反映される (#20)";
  console.log(`\n${scenario}`);
  const env = makeEnv("g-exclude");
  const count = async (patterns: string[]) => {
    env.settings.excludePatterns = patterns;
    const { groups } = await scan(env);
    const names = groups.flatMap((g) => g.files.map((f) => f.name));
    return { total: names.length, lrf: names.filter((n) => n.endsWith(".LRF")).length };
  };
  const all = FILES_PER_DAY * DAYS.length;
  const lrf = await count(["*.LRF"]);
  check("[#20] *.LRF で .LRF が除外される", lrf.lrf === 0 && lrf.total === all, JSON.stringify(lrf));
  const none = await count([]);
  check("[#20] 除外なしなら .LRF も対象になる", none.lrf === 1 && none.total === all + 1, JSON.stringify(none));
  const mp4 = await count(["*.MP4", "*.LRF"]);
  check("[#20] 複数パターンがすべて効く", mp4.total === 0, JSON.stringify(mp4));
  const day = await count(["DJI_20260921*"]);
  check("[#20] * のパターンで特定の日付だけ除外できる", day.total === FILES_PER_DAY + 1, JSON.stringify(day));
  const q = await count(["*.LR?"]);
  check("[#20] ? のパターンが効く", q.lrf === 0 && q.total === all, JSON.stringify(q));
}

// ---------- H. スキップと進捗・速度・残り時間 ----------

async function scenarioSkipAndProgress(): Promise<void> {
  scenario = "H. スキップした日付と進捗・速度・残り時間 (#21, #22, #28)";
  console.log(`\n${scenario}`);
  const env = makeEnv("h-skip");
  const { spec, groups } = await scan(env);
  const skipped = groups.find((g) => g.date === "2026-09-21");
  if (!skipped) throw new Error("2日目のグループがありません");
  spec.input.plans[skipped.id] = { kind: "skip" };
  // スキップする日付だけ巨大にする: スキップ分を容量計算に含めると未承認で中止になる
  skipped.totalBytes = 1e18;

  await startJob({ paths: env.paths, workerScript: WORKER, nodePath: nodePath(), spec });
  const samples: RunState[] = [];
  const done = await waitFor(
    env,
    (s) => {
      if (s.kind === "running") samples.push(s.state);
      return s.kind !== "running" && s.kind !== "starting";
    },
    60_000,
  );
  const state = done.kind === "finished" ? done.state : undefined;
  check(
    "[#28] スキップした日付は容量チェックに含まれない (中止されない)",
    state?.phase === "finished",
    `${state?.phase} ${state?.fatalError ?? ""}`,
  );
  check(
    "[#21] 合計はスキップ分を含まない",
    state?.totalFiles === FILES_PER_DAY && state.totalBytes === FILES_PER_DAY * FILE_BYTES,
    `${state?.totalFiles}ファイル / ${state?.totalBytes}B`,
  );
  check(
    "[#21] スキップした日付は最初から skipped",
    samples.length > 0 && samples.every((s) => s.groups.find((g) => g.id === skipped.id)?.status === "skipped"),
    `${samples.length}サンプル`,
  );

  const now = Date.now();
  const running = samples.map((s) => progressStats(s, now));
  const finite = (n: number | undefined) => n === undefined || (Number.isFinite(n) && n >= 0);
  check(
    "[#22] 転送中の進捗・速度・残り時間は常に有限",
    running.every((p) => p.ratio >= 0 && p.ratio <= 1 && finite(p.bytesPerSec) && finite(p.etaMs)),
    `${running.length}サンプル`,
  );
  check(
    "[#22] 進捗は後戻りしない",
    running.every((p, i) => i === 0 || p.processedBytes >= running[i - 1].processedBytes),
  );
  const beforeTransfer = samples.filter((s) => s.transferStartedAt === undefined).map((s) => progressStats(s, now));
  check(
    "[#22] 転送開始前は速度・残り時間を出さない",
    beforeTransfer.every((p) => p.bytesPerSec === undefined && p.etaMs === undefined),
    `${beforeTransfer.length}サンプル`,
  );
  if (state) {
    const final = progressStats(state);
    check("[#21] 完了時は 100%", final.ratio === 1 && final.processedBytes === final.totalBytes, `${final.ratio}`);
    check("[#22] 完了後は残り時間を出さない", final.etaMs === undefined);
  }

  // 速度・残り時間の計算そのもの (転送開始から 10 秒で 1/4 → 速度一定なら残り 30 秒)
  const base = samples[0] ?? state;
  if (base) {
    const t0 = 1_000_000;
    const synthetic: RunState = {
      ...base,
      phase: "running",
      startedAt: t0 - 5000,
      transferStartedAt: t0,
      finishedAt: undefined,
      totalBytes: 400,
      doneBytes: 100,
      failedBytes: 0,
      groups: base.groups.map((g) => ({ ...g, status: "done" as const })),
    };
    const p = progressStats(synthetic, t0 + 10_000);
    check(
      "[#22] 速度 = 処理済み ÷ 転送開始からの時間、残り = 残量 ÷ 速度",
      p.bytesPerSec === 10 && p.etaMs === 30_000 && p.ratio === 0.25 && p.elapsedMs === 15_000,
      JSON.stringify(p),
    );
    const early = progressStats(synthetic, t0 + 500);
    check("[#22] 計測 2 秒未満は速度を出さない (極端な値を避ける)", early.bytesPerSec === undefined);
    const empty = progressStats(
      { ...synthetic, totalBytes: 0, doneBytes: 0, totalFiles: 0, doneFiles: 0 },
      t0 + 10_000,
    );
    check("[#22] 合計 0 でも NaN にならない", empty.ratio === 0 && empty.bytesPerSec === undefined);
  }
}

// ---------- I. 履歴の読み込み ----------

async function scenarioHistoryFiles(): Promise<void> {
  scenario = "I. 履歴ファイルの読み込み (#24)";
  console.log(`\n${scenario}`);
  const dir = path.join(SANDBOX, "i-history");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const summary = (startedAt: number) =>
    JSON.stringify({
      version: 1,
      startedAt,
      groups: [],
      failed: [],
      phase: "finished",
      ssdMount: "/x",
      footageRoot: "/x/f",
    });

  fs.writeFileSync(path.join(dir, "newvlog-20260901-100000.log"), "old\n");
  fs.writeFileSync(path.join(dir, "newvlog-20260910-100000.log"), "new\n");
  fs.writeFileSync(path.join(dir, "newvlog-20260910-100000.json"), summary(Date.UTC(2026, 8, 10, 10)));
  fs.writeFileSync(path.join(dir, "newvlog-20260905-100000.log"), "broken summary\n");
  fs.writeFileSync(path.join(dir, "newvlog-20260905-100000.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "newvlog-20260906-100000.json"), JSON.stringify({ version: 2 }));
  fs.writeFileSync(path.join(dir, "newvlog-20260907-100000.json.tmp"), summary(0));
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "x");

  const entries = await readRunHistory(dir);
  check(
    "[#24] 壊れた要約・未知の形式・書きかけは無視し、読める分を返す",
    entries.length === 3,
    entries.map((e) => `${e.kind}:${e.id}`).join(", "),
  );
  check(
    "[#24] 要約のあるログは run、無い (壊れた) ものは legacy",
    entries[0]?.kind === "run" && entries[1]?.kind === "legacy" && entries[2]?.kind === "legacy",
  );
  check(
    "[#24] 新しい順に並ぶ",
    entries.every((e, i) => i === 0 || entries[i - 1].startedAt >= e.startedAt),
  );
  check("[#24] ログフォルダが無くても空で返る", (await readRunHistory(path.join(dir, "nope"))).length === 0);
}

// ---------- J. プランの自動提案 ----------

async function scenarioSuggestPlan(): Promise<void> {
  scenario = "J. プランの自動提案 (#25)";
  console.log(`\n${scenario}`);
  const env = makeEnv("j-suggest");
  const { groups } = await scan(env);
  const g = groups[0];
  const defaults = { defaultTitle: "Trip", defaultTier: "TIER_1__KEEP" as const };
  const p = (tier: "TIER_1__KEEP" | "TIER_2__STORE", name: string) => ({ tier, name, path: `/x/${tier}/${name}` });

  const none = suggestPlan({ ...g, existing: [] }, defaults);
  check(
    "[#25] 既存が無ければ既定のタイトル・Tier で新規",
    none?.kind === "new" && none.title === "Trip" && none.tier === "TIER_1__KEEP",
    JSON.stringify(none),
  );
  const one = suggestPlan({ ...g, existing: [p("TIER_2__STORE", "2026-09-20-A")] }, defaults);
  check(
    "[#25] 既存が 1 つならそれを使う",
    one?.kind === "existing" && one.projectDir === "/x/TIER_2__STORE/2026-09-20-A",
    JSON.stringify(one),
  );
  const two = suggestPlan(
    { ...g, existing: [p("TIER_2__STORE", "2026-09-20-A"), p("TIER_1__KEEP", "2026-09-20-B")] },
    defaults,
  );
  check("[#25] 既存が 2 つ以上なら未決定のまま", two === undefined, JSON.stringify(two));
}

// ---------- レポート ----------

function writeReport(startedAt: Date): boolean {
  const passed = checks.filter((c) => c.ok).length;
  const allOk = passed === checks.length;
  const lines = [
    "# New Vlog Import E2E レポート",
    "",
    `- 実行日時: ${startedAt.toISOString()}`,
    `- ワーカー: \`assets/worker.js\` / node: \`${nodePath()}\` (${execFileSync(nodePath(), ["-v"], { encoding: "utf8" }).trim()})`,
    `- 条件: ${DAYS.length}日 × ${FILES_PER_DAY}ファイル (${FILE_BYTES / 1024} KiB)`,
    `- 結果: **${allOk ? "PASS" : "FAIL"}** (${passed}/${checks.length})`,
    "",
  ];
  let current = "";
  for (const c of checks) {
    if (c.scenario !== current) {
      current = c.scenario;
      lines.push("", `## ${current}`, "", "| | 検証 | 詳細 |", "|---|---|---|");
    }
    lines.push(`| ${c.ok ? "✅" : "❌"} | ${c.name} | ${c.detail.replace(/\|/g, "\\|")} |`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ startedAt, allOk, checks }, null, 2));
  return allOk;
}

async function main(): Promise<void> {
  // Raycast 役の親プロセスとして起動された場合
  if (process.argv[2] === "--launcher") {
    const [, , , dir, specFile, worker, node] = process.argv;
    const paths = jobPaths(path.dirname(dir));
    await startJob({ paths, workerScript: worker, nodePath: node, spec: parseSpec(fs.readFileSync(specFile, "utf8")) });
    process.kill(process.pid, "SIGKILL");
    return;
  }
  // 同時起動テストの競争相手
  if (process.argv[2] === "--racer") {
    const [, , , dir, specFile, worker, node, startAt] = process.argv;
    const paths = jobPaths(path.dirname(dir));
    const spec = parseSpec(fs.readFileSync(specFile, "utf8"));
    while (Date.now() < Number(startAt)) await sleep(1);
    let result: RaceResult;
    try {
      result = { ok: true, pid: await startJob({ paths, workerScript: worker, nodePath: node, spec }) };
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  // 設定を保存し続けるプロセス (F の同時読み書き用)
  if (process.argv[2] === "--settings-writer") {
    const file = process.argv[3];
    const { settings } = validateSettings({ ...DEFAULT_INPUT, ssdUuid: "UUID-W" });
    if (!settings) throw new Error("invalid");
    for (let i = 0; ; i++) {
      saveSettingsTo(file, { ...settings, defaultTitle: `T${i}`.repeat(1 + (i % 50)) });
      if (i % 20 === 0) await sleep(0);
    }
  }
  // ロックを取ったまま居座るプロセス (SIGKILL で殺される役)
  if (process.argv[2] === "--lockholder") {
    fs.mkdirSync(path.dirname(process.argv[3]), { recursive: true });
    const { O_RDWR, O_CREAT } = fs.constants;
    fs.openSync(process.argv[3], O_RDWR | O_CREAT | 0x20 /* O_EXLOCK */);
    process.stdout.write("locked\n");
    setInterval(() => {}, 1000);
    return;
  }

  const startedAt = new Date();
  if (!fs.existsSync(WORKER)) throw new Error("assets/worker.js がありません (npm run build:worker)");
  fs.rmSync(SANDBOX, { recursive: true, force: true });

  for (const s of [
    scenarioHappyPath,
    scenarioDoubleStartAndCancel,
    scenarioCrashAndResume,
    scenarioSpace,
    scenarioConcurrentStart,
    scenarioSettings,
    scenarioExcludePatterns,
    scenarioSkipAndProgress,
    scenarioHistoryFiles,
    scenarioSuggestPlan,
  ]) {
    try {
      await s();
    } catch (e) {
      check("シナリオが例外なく完了する", false, (e as Error).stack ?? String(e));
    }
  }

  const ok = writeReport(startedAt);
  console.log(`\n${ok ? "PASS" : "FAIL"} → ${path.join("e2e", ".out", "report.md")}`);
  if (ok) fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

void main();
