// Raycast 上での、バックグラウンドジョブ・設定・ログの場所と起動方法
import { LaunchType, environment, launchCommand } from "@raycast/api";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobPaths, jobPaths } from "./job";
import { LoadedSettings, Settings, loadSettingsFrom, saveSettingsTo, settingsFile } from "./settings";

export function raycastJobPaths(): JobPaths {
  return jobPaths(environment.supportPath);
}

export function loadRaycastSettings(): LoadedSettings {
  return loadSettingsFrom(settingsFile(environment.supportPath));
}

export function saveRaycastSettings(settings: Settings): void {
  saveSettingsTo(settingsFile(environment.supportPath), settings);
}

export function raycastSettingsFile(): string {
  return settingsFile(environment.supportPath);
}

/** 転送ログと履歴用の要約の保存先 */
export function logDirPath(): string {
  return path.join(environment.supportPath, "logs");
}

/** メニューバーの表示をすぐ更新する (メニューバーコマンドが無効なら何もしない) */
export async function refreshMenuBar(): Promise<void> {
  try {
    await launchCommand({ name: "transfer-status", type: LaunchType.Background });
  } catch {
    // メニューバーコマンドを有効にしていない場合など
  }
}

export function workerScriptPath(): string {
  return path.join(environment.assetsPath, "worker.js");
}

/**
 * ワーカーを動かす node バイナリ。
 * ユーザーの PATH にある node は当てにせず、Raycast 自身が拡張の実行に使っている node を使う。
 */
export function nodeBinaryPath(): string {
  if (path.basename(process.execPath) === "node") return process.execPath;

  const runtimeDir = path.join(os.homedir(), "Library/Application Support/com.raycast.macos/NodeJS/runtime");
  try {
    const versions = fs.readdirSync(runtimeDir).sort().reverse();
    for (const version of versions) {
      const candidate = path.join(runtimeDir, version, "bin/node");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // 下で例外にする
  }
  throw new Error(`転送ワーカー用の node が見つかりません (process.execPath: ${process.execPath})`);
}
