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
import { computeSpaceInfo } from "../src/lib/engine";
import {
  JobPaths,
  JobSpec,
  JobStatus,
  cancelJob,
  jobPaths,
  parseSpec,
  readJob,
  serializeSpec,
  startJob,
} from "../src/lib/job";
import type { Plan } from "../src/lib/plan";
import { DateGroup, detectDevices, scanDevice } from "../src/lib/scan";
import type { Settings } from "../src/lib/settings";
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
      openInFinder: false,
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

// ---------- レポート ----------

function writeReport(startedAt: Date): boolean {
  const passed = checks.filter((c) => c.ok).length;
  const allOk = passed === checks.length;
  const lines = [
    "# バックグラウンド転送 E2E レポート",
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

  const startedAt = new Date();
  if (!fs.existsSync(WORKER)) throw new Error("assets/worker.js がありません (npm run build:worker)");
  fs.rmSync(SANDBOX, { recursive: true, force: true });

  for (const s of [scenarioHappyPath, scenarioDoubleStartAndCancel, scenarioCrashAndResume, scenarioSpace]) {
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
