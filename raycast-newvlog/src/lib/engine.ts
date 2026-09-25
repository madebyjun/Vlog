// 転送エンジン: newvlog.sh の「フォルダ準備フェーズ」「転送フェーズ」に相当。
// UI とは独立して動作し、購読者に進捗を通知する。
// 実際には Raycast から切り離したワーカープロセス (worker.ts) の中で動く。

import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { formatGib } from "./format";
import type { Plan } from "./plan";
import type { DateGroup, DetectedDevice } from "./scan";
import type { Settings } from "./settings";
import { SsdContext, getFreeBytes, isDirectory } from "./ssd";
import { run } from "./shell";

export type RunPhase = "running" | "finished" | "aborted";

export type GroupStatus =
  | "pending" // 未処理
  | "skipped" // ユーザーがスキップ
  | "preparing" // フォルダ準備中
  | "ready" // 準備完了 (転送待ち)
  | "transferring" // 転送中
  | "done" // 全ファイル成功
  | "partial" // 一部失敗
  | "failed"; // 致命的エラーで中断

export interface GroupProgress {
  id: string;
  deviceName: string;
  date: string;
  status: GroupStatus;
  projectDir?: string;
  destDir?: string;
  totalFiles: number;
  totalBytes: number;
  doneFiles: number;
  failedFiles: number;
  doneBytes: number;
  currentFile?: string;
  currentFileSize?: number;
  currentFileBytes?: number;
  failedNames: string[];
}

export interface RunState {
  phase: RunPhase;
  groups: GroupProgress[];
  log: string[];
  /** "デバイス名: ファイル名 (x.x GiB)" */
  failed: string[];
  fatalError?: string;
  currentDevice?: string;
  startedAt: number;
  /** 最初のファイルの転送を始めた時刻 (速度計算用。フォルダ準備の時間を含めない) */
  transferStartedAt?: number;
  finishedAt?: number;
  /** スキップした日付を除いた合計 */
  totalFiles: number;
  totalBytes: number;
  doneFiles: number;
  doneBytes: number;
  /** 転送に失敗したファイルのバイト数 (処理済みとして進捗に含める) */
  failedBytes?: number;
  cancelRequested: boolean;
  logFile?: string;
}

export interface SpaceInfo {
  deviceName: string;
  totalBytes: number;
  fileCount: number;
  marginBytes: number;
  requiredBytes: number;
  freeBytes: number;
  shortageBytes: number;
  /** true: 転送サイズ自体が空きを超える / false: マージンのみ確保できない */
  insufficient: boolean;
}

export interface RunHooks {
  /** 容量不足時の確認。true = このまま転送, false = 中止 */
  confirmSpace: (info: SpaceInfo) => Promise<boolean>;
}

export interface RunInput {
  ctx: SsdContext;
  settings: Settings;
  devices: DetectedDevice[];
  groups: DateGroup[];
  plans: Record<string, Plan>;
  /** ログファイルの保存先ディレクトリ */
  logDir: string;
}

class AbortError extends Error {}

function isSkipped(plan: Plan | undefined): boolean {
  return !plan || plan.kind === "skip";
}

/** 履歴画面用に保存する実行結果 (ログ本文は別ファイル) */
export type RunSummary = Omit<RunState, "log"> & { version: 1; ssdMount: string; footageRoot: string };

/**
 * デバイス単位の容量チェック。問題なければ null。
 * (ワーカーでの実チェックと、開始前に UI で行う見積もりの両方で使う)
 */
export function computeSpaceInfo(
  deviceName: string,
  deviceGroups: DateGroup[],
  marginBytes: number,
  freeBytes: number,
): SpaceInfo | null {
  const totalBytes = deviceGroups.reduce((s, g) => s + g.totalBytes, 0);
  const fileCount = deviceGroups.reduce((s, g) => s + g.files.length, 0);
  const requiredBytes = totalBytes + marginBytes;
  if (requiredBytes <= freeBytes) return null;
  return {
    deviceName,
    totalBytes,
    fileCount,
    marginBytes,
    requiredBytes,
    freeBytes,
    shortageBytes: requiredBytes - freeBytes,
    insufficient: totalBytes > freeBytes,
  };
}

const RSYNC = "/usr/bin/rsync";
const CP = "/bin/cp";
const OPEN = "/usr/bin/open";

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsNoFollow(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export class TransferRun {
  private state: RunState;
  private readonly listeners = new Set<(state: RunState) => void>();
  private child: ChildProcess | undefined;
  private readonly input: RunInput;
  private readonly hooks: RunHooks;

  constructor(input: RunInput, hooks: RunHooks) {
    this.input = input;
    this.hooks = hooks;
    const groups: GroupProgress[] = input.groups.map((g) => ({
      id: g.id,
      deviceName: g.device.name,
      date: g.date,
      // スキップする日付は最初から skipped にして、合計・進捗に含めない
      status: isSkipped(input.plans[g.id]) ? "skipped" : "pending",
      totalFiles: g.files.length,
      totalBytes: g.totalBytes,
      doneFiles: 0,
      failedFiles: 0,
      doneBytes: 0,
      failedNames: [],
    }));
    this.state = {
      phase: "running",
      groups,
      log: [],
      failed: [],
      startedAt: Date.now(),
      totalFiles: groups.filter((g) => g.status !== "skipped").reduce((s, g) => s + g.totalFiles, 0),
      totalBytes: groups.filter((g) => g.status !== "skipped").reduce((s, g) => s + g.totalBytes, 0),
      doneFiles: 0,
      doneBytes: 0,
      failedBytes: 0,
      cancelRequested: false,
    };
  }

  // ---------- 公開API ----------

  get phase(): RunPhase {
    return this.state.phase;
  }

  snapshot(): RunState {
    return {
      ...this.state,
      groups: this.state.groups.map((g) => ({ ...g, failedNames: [...g.failedNames] })),
      log: [...this.state.log],
      failed: [...this.state.failed],
    };
  }

  subscribe(listener: (state: RunState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 転送を開始する。返り値は全処理 (中止・異常終了を含む) の完了 */
  start(): Promise<void> {
    return this.execute();
  }

  /** 中止を要求する。転送中のファイルは停止され、履歴には記録されない */
  cancel(): void {
    if (this.state.phase !== "running" || this.state.cancelRequested) return;
    this.state.cancelRequested = true;
    this.log("🛑 中止を要求しました。現在のファイルを停止します...");
    this.child?.kill("SIGTERM");
    this.emit();
  }

  // ---------- 内部 ----------

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  private log(line: string): void {
    this.state.log.push(line);
  }

  private group(id: string): GroupProgress {
    const g = this.state.groups.find((x) => x.id === id);
    if (!g) throw new Error(`内部エラー: グループが見つかりません (${id})`);
    return g;
  }

  private checkCancelled(): void {
    if (this.state.cancelRequested) {
      throw new AbortError("🛑 ユーザー操作により中止しました。");
    }
  }

  private async execute(): Promise<void> {
    const { devices, groups } = this.input;
    try {
      for (const device of devices) {
        const deviceGroups = groups.filter((g) => g.device.name === device.name);
        this.state.currentDevice = device.name;
        this.log("════════════════════════════════════════════");
        this.log(`📡 ${device.name} チェック中...`);
        this.log(`📂 読み込み元: ${device.sourceDir}`);
        this.emit();

        if (deviceGroups.length === 0) {
          this.log("🎉 新しいファイルはありません。");
          this.emit();
          continue;
        }
        this.log(`💡 転送対象の日付: ${deviceGroups.map((g) => g.date).join(" ")}`);

        // --- 容量事前チェック ---
        await this.checkSpace(device, deviceGroups);
        this.checkCancelled();

        // --- フォルダ準備フェーズ ---
        this.log("🛠 フォルダ準備フェーズ...");
        this.emit();
        const skipped: string[] = [];
        for (const g of deviceGroups) {
          this.checkCancelled();
          await this.prepareGroup(g, skipped);
        }

        // --- 転送フェーズ ---
        this.log("🚚 転送フェーズ...");
        if (skipped.length > 0) {
          this.log(`⏭  スキップした日付: ${skipped.join(" ")}`);
        }
        this.emit();
        for (const g of deviceGroups) {
          const progress = this.group(g.id);
          if (progress.status !== "ready") continue;
          await this.transferGroup(g);
        }
      }

      this.state.phase = "finished";
      if (this.state.failed.length > 0) {
        this.logFailureSummary();
      } else {
        this.log("🎉 全処理完了！");
      }
    } catch (error) {
      this.state.phase = "aborted";
      const message = error instanceof Error ? error.message : String(error);
      this.state.fatalError = message;
      if (!(error instanceof AbortError)) {
        this.log(`❌ ${message}`);
      } else {
        this.log(message);
      }
      for (const g of this.state.groups) {
        if (g.status === "transferring" || g.status === "preparing") g.status = "failed";
        if (g.status === "pending") g.status = "skipped";
        g.currentFile = undefined;
      }
      if (this.state.failed.length > 0) this.logFailureSummary();
    } finally {
      this.state.currentDevice = undefined;
      this.state.finishedAt = Date.now();
      await this.writeLogFile();
      this.emit();
    }
  }

  private logFailureSummary(): void {
    this.log(`⚠️  転送に失敗したファイルが ${this.state.failed.length} 件あります:`);
    for (const entry of this.state.failed) this.log(`   - ${entry}`);
    this.log("💡 これらは履歴に記録されていないため、原因を解消して再実行すれば失敗分だけ再転送されます。");
    this.log("   容量不足の場合は、SSDの空き容量を確保してください。");
  }

  private async checkSpace(device: DetectedDevice, deviceGroups: DateGroup[]): Promise<void> {
    const { ctx, settings } = this.input;
    const freeBytes = await getFreeBytes(ctx.mount);
    // スキップする日付は容量の計算に含めない
    const transferring = deviceGroups.filter((g) => !isSkipped(this.input.plans[g.id]));
    const info = computeSpaceInfo(device.name, transferring, settings.spaceMarginBytes, freeBytes);
    if (!info) return;

    this.log(
      info.insufficient
        ? "⚠️  SSDの空き容量が不足しています"
        : "⚠️  転送は可能な見込みですが、安全マージンを確保できません",
    );
    this.log(`    転送予定:       ${formatGib(info.totalBytes)} (${info.fileCount}ファイル)`);
    this.log(`    安全マージン:    ${formatGib(info.marginBytes)}`);
    this.log(`    必要空き容量:   ${formatGib(info.requiredBytes)}`);
    this.log(`    現在の空き容量: ${formatGib(info.freeBytes)}`);
    this.log(`    追加で必要:     ${formatGib(info.shortageBytes)}`);
    this.emit();

    const proceed = await this.hooks.confirmSpace(info);
    if (!proceed) {
      throw new AbortError("🛑 中止しました。空き容量を確保してから再実行してください。");
    }
    this.log("👉 このまま転送を開始します (入るところまで転送)");
    this.emit();
  }

  private async prepareGroup(g: DateGroup, skipped: string[]): Promise<void> {
    const progress = this.group(g.id);
    const plan = this.input.plans[g.id];
    this.log(`📅 [ ${g.device.name} ] ${g.date}`);

    if (!plan || plan.kind === "skip") {
      progress.status = "skipped";
      skipped.push(g.date);
      this.log("  ⏭  スキップしました (履歴には記録されないため、次回実行時に再度転送対象になります)");
      this.emit();
      return;
    }

    progress.status = "preparing";
    this.emit();

    let projectDir: string;
    if (plan.kind === "existing") {
      projectDir = plan.projectDir;
      this.log(`  ⚡️ 既存プロジェクトを使用: ${plan.projectName}`);
    } else {
      projectDir = await this.createNewProject(g.date, plan.title, plan.tier);
    }

    // 転送先決定 (ここでフォルダだけ先に準備する)
    const destDir = g.device.destFolderName
      ? path.join(projectDir, g.device.destFolderName)
      : path.join(projectDir, "Footage", g.device.name);
    try {
      await fs.mkdir(destDir, { recursive: true });
    } catch {
      throw new Error(`転送先フォルダを作成できませんでした: ${destDir}`);
    }

    progress.projectDir = projectDir;
    progress.destDir = destDir;
    progress.status = "ready";
    this.log(`  📁 準備完了: ${destDir}`);
    this.emit();
  }

  /** 新規プロジェクトフォルダを作成 (Tierフォルダ作成・連番回避・テンプレートコピー・Assetsリンク) */
  private async createNewProject(date: string, title: string, tier: string): Promise<string> {
    const { ctx } = this.input;
    const tierPath = path.join(ctx.footageRoot, tier);

    if (!(await isDirectory(tierPath))) {
      this.log(`  📁 Tierフォルダを作成: ${tier}`);
      try {
        await fs.mkdir(tierPath, { recursive: true });
      } catch {
        throw new Error(`Tierフォルダを作成できませんでした: ${tierPath}`);
      }
    }

    const baseDir = path.join(tierPath, `${date}-${title}`);
    let projectDir = baseDir;
    let count = 1;
    while (await pathExists(projectDir)) {
      projectDir = `${baseDir}-${count}`;
      count += 1;
    }

    try {
      await fs.mkdir(projectDir, { recursive: true });
    } catch {
      throw new Error(`プロジェクトフォルダを作成できませんでした: ${projectDir}`);
    }

    if (await isDirectory(ctx.templateDir)) {
      try {
        await run(CP, ["-R", `${ctx.templateDir}/.`, projectDir]);
      } catch {
        await this.cleanupIncompleteProject(projectDir, tierPath);
        throw new Error("テンプレートをコピーできませんでした (SSDの空き容量を確認してください)");
      }
    }

    const assetsLink = path.join(projectDir, "Assets");
    if ((await isDirectory(ctx.assetsDir)) && !(await pathExistsNoFollow(assetsLink))) {
      try {
        await fs.symlink(ctx.assetsDir, assetsLink);
      } catch {
        await this.cleanupIncompleteProject(projectDir, tierPath);
        throw new Error(`Assetsリンクを作成できませんでした: ${assetsLink}`);
      }
    }

    this.log(`  🆕 作成先: ${tier}/${path.basename(projectDir)}`);
    return projectDir;
  }

  /**
   * 作成途中の新規プロジェクトフォルダを削除する。
   * 実パスが期待する親(Tier)配下であることを検証してから削除する。
   */
  private async cleanupIncompleteProject(target: string, expectedParent: string): Promise<void> {
    let targetReal: string;
    let parentReal: string;
    try {
      targetReal = await fs.realpath(target);
    } catch {
      this.log(`⚠️ 削除対象を確認できませんでした: ${target}`);
      return;
    }
    try {
      parentReal = await fs.realpath(expectedParent);
    } catch {
      this.log(`⚠️ 親フォルダを確認できませんでした: ${expectedParent}`);
      return;
    }
    if (targetReal === parentReal || !targetReal.startsWith(`${parentReal}/`)) {
      this.log(`⚠️ 安全確認できないため削除しません: ${targetReal}`);
      return;
    }
    this.log(`   作成途中のプロジェクトフォルダを削除します: ${targetReal}`);
    try {
      await fs.rm(targetReal, { recursive: true, force: true });
    } catch {
      this.log(`⚠️ 削除に失敗しました。手動で確認してください: ${targetReal}`);
    }
  }

  private async transferGroup(g: DateGroup): Promise<void> {
    const { ctx, settings } = this.input;
    const progress = this.group(g.id);
    const destDir = progress.destDir;
    const projectDir = progress.projectDir;
    if (!destDir || !projectDir) return;

    progress.status = "transferring";
    this.state.transferStartedAt ??= Date.now();
    this.log(`🚀 [ ${g.device.name} ] ${g.date} -> ${destDir}`);
    this.emit();

    for (const file of g.files) {
      this.checkCancelled();

      progress.currentFile = file.name;
      progress.currentFileSize = file.size;
      progress.currentFileBytes = 0;
      this.emit();

      const ok = await this.rsyncFile(file.path, destDir, file.name, (bytes) => {
        progress.currentFileBytes = Math.min(bytes, file.size);
        this.emit();
      });

      if (this.state.cancelRequested) {
        // 中止によって停止したファイルは失敗扱いにせず、履歴にも残さない (再実行で再転送される)
        progress.currentFile = undefined;
        this.checkCancelled();
      }

      if (ok) {
        // 追記できないまま続行すると以降の成功も未記録になるため明示的に中止
        try {
          await fs.appendFile(ctx.historyFile, `${g.device.name}:${file.name}\n`);
        } catch {
          this.log(`   ※ ${file.name} 自体の転送は完了しています`);
          throw new Error(`履歴ファイルに記録できませんでした (SSDの空き容量を確認してください): ${ctx.historyFile}`);
        }
        ctx.imported.add(`${g.device.name}:${file.name}`);
        progress.doneFiles += 1;
        progress.doneBytes += file.size;
        this.state.doneFiles += 1;
        this.state.doneBytes += file.size;
      } else {
        progress.failedFiles += 1;
        progress.failedNames.push(file.name);
        this.state.failedBytes = (this.state.failedBytes ?? 0) + file.size;
        this.state.failed.push(`${g.device.name}: ${file.name} (${formatGib(file.size)})`);
      }
      progress.currentFile = undefined;
      progress.currentFileBytes = undefined;
      progress.currentFileSize = undefined;
      this.emit();
    }

    if (progress.failedFiles > 0) {
      progress.status = "partial";
      this.log(`  ⚠️ 処理終了 (成功 ${progress.doneFiles}件 / 失敗 ${progress.failedFiles}件)`);
    } else {
      progress.status = "done";
      this.log(`  ✅ 完了 (${progress.doneFiles} ファイル)`);
    }
    this.emit();

    if (settings.openInFinder) {
      try {
        await run(OPEN, [projectDir]);
      } catch {
        // open 失敗は無視 (スクリプトの `|| true` 相当)
      }
    }
  }

  /** 1ファイルを rsync -a で転送する。成功なら true */
  private rsyncFile(src: string, destDir: string, fname: string, onBytes: (bytes: number) => void): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.child = undefined;
        resolve(ok);
      };

      const child = spawn(RSYNC, ["-a", src, `${destDir}/`], { stdio: ["ignore", "ignore", "pipe"] });
      this.child = child;
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      // rsync は転送中 ".<ファイル名>.XXXXXX" の一時ファイルに書き込むので、そのサイズで進捗を推定する
      const timer = setInterval(async () => {
        try {
          const entries = await fs.readdir(destDir);
          const tmp = entries.find((e) => e.startsWith(`.${fname}.`));
          if (tmp) {
            const st = await fs.stat(path.join(destDir, tmp));
            onBytes(st.size);
          }
        } catch {
          // 進捗推定に失敗しても転送自体には影響しない
        }
      }, 500);

      child.on("error", (error) => {
        this.log(`⚠️ 転送失敗: ${fname} (rsync を起動できません: ${error.message})`);
        finish(false);
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          finish(true);
          return;
        }
        if (!this.state.cancelRequested) {
          const detail = stderr.trim().split("\n").filter(Boolean).pop();
          this.log(`⚠️ 転送失敗: ${fname}${detail ? ` (${detail})` : signal ? ` (${signal})` : ""}`);
        }
        finish(false);
      });
    });
  }

  private async writeLogFile(): Promise<void> {
    try {
      await fs.mkdir(this.input.logDir, { recursive: true });
      const stamp = new Date(this.state.startedAt)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "")
        .replace("T", "-");
      const file = path.join(this.input.logDir, `newvlog-${stamp}.log`);
      await fs.writeFile(file, `${this.state.log.join("\n")}\n`, "utf8");
      this.state.logFile = file;

      // 履歴画面用の要約。書きかけを読まれないよう一時ファイルから rename する
      const snapshot: Partial<RunState> = this.snapshot();
      delete snapshot.log;
      const summary: RunSummary = {
        ...(snapshot as Omit<RunState, "log">),
        version: 1,
        ssdMount: this.input.ctx.mount,
        footageRoot: this.input.ctx.footageRoot,
      };
      const json = file.replace(/\.log$/, ".json");
      await fs.writeFile(`${json}.tmp`, JSON.stringify(summary), "utf8");
      await fs.rename(`${json}.tmp`, json);
    } catch {
      // ログ保存の失敗は転送結果に影響しない
    }
  }
}
