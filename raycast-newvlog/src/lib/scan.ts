import * as fs from "node:fs/promises";
import path from "node:path";
import { DEVICE_RULES, DeviceRule, EXCLUDE_PATTERNS, TIER_FOLDERS, Tier } from "./config";
import { calculateShootingDate } from "./date";
import { globToRegExp } from "./format";
import { Settings } from "./settings";
import { SsdContext, isDirectory } from "./ssd";

export interface DetectedDevice {
  /** 例: OsmoAction_1, DJI_Mic_2 (履歴キーの接頭辞) */
  name: string;
  volume: string;
  sourceDir: string;
  destFolderName: string;
  dateRegex: RegExp;
}

export interface ScannedFile {
  path: string;
  name: string;
  size: number;
  /** YYYY-MM-DD (切り替え時刻を考慮した撮影日) */
  date: string;
}

export interface ExistingProject {
  tier: Tier;
  name: string;
  path: string;
}

/** デバイス × 撮影日 の転送単位 */
export interface DateGroup {
  id: string;
  device: DetectedDevice;
  date: string;
  files: ScannedFile[];
  totalBytes: number;
  /** 全Tierから見つかった「YYYY-MM-DD-*」の既存プロジェクト */
  existing: ExistingProject[];
}

const DEFAULT_VOLUMES_DIR = "/Volumes";

async function isDirectoryNoFollow(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** マウント済みボリュームからデバイスを検出する (SSD自身は除外) */
export async function detectDevices(ssdMount: string, volumesDir = DEFAULT_VOLUMES_DIR): Promise<DetectedDevice[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(volumesDir);
  } catch {
    return [];
  }

  // zsh の /Volumes/*(N/) と同じく、シンボリックリンクではない実ディレクトリのみ・名前順
  const volumes: string[] = [];
  for (const entry of entries.sort()) {
    const vol = path.join(volumesDir, entry);
    if (vol === ssdMount) continue;
    if (await isDirectoryNoFollow(vol)) volumes.push(vol);
  }

  const counts = new Map<DeviceRule, number>();
  const devices: DetectedDevice[] = [];
  for (const vol of volumes) {
    for (const rule of DEVICE_RULES) {
      const found = counts.get(rule) ?? 0;
      if (found >= rule.destDirs.length) continue;
      if (!(await isDirectory(path.join(vol, rule.detectPath)))) continue;
      counts.set(rule, found + 1);
      devices.push({
        name: `${rule.namePrefix}_${found + 1}`,
        volume: vol,
        sourceDir: path.join(vol, rule.sourcePath),
        destFolderName: rule.destDirs[found],
        dateRegex: rule.dateRegex,
      });
    }
  }
  return devices;
}

/** 全Tierから「YYYY-MM-DD-*」の既存プロジェクトフォルダを探す */
export async function findExistingProjects(footageRoot: string, date: string): Promise<ExistingProject[]> {
  const result: ExistingProject[] = [];
  for (const tier of TIER_FOLDERS) {
    const tierPath = path.join(footageRoot, tier);
    if (!(await isDirectory(tierPath))) continue;
    let entries: string[];
    try {
      entries = await fs.readdir(tierPath);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.startsWith(`${date}-`)) continue;
      const full = path.join(tierPath, entry);
      if (await isDirectoryNoFollow(full)) {
        result.push({ tier, name: entry, path: full });
      }
    }
  }
  return result;
}

/**
 * デバイスの読み込み元をスキャンし、未転送ファイルを撮影日ごとにまとめる。
 * 履歴済み・除外パターン一致・日付不明のファイルは対象外。
 */
export async function scanDevice(device: DetectedDevice, ctx: SsdContext, settings: Settings): Promise<DateGroup[]> {
  let names: string[];
  try {
    names = (await fs.readdir(device.sourceDir)).sort();
  } catch {
    return [];
  }

  const excludes = EXCLUDE_PATTERNS.map(globToRegExp);
  const byDate = new Map<string, ScannedFile[]>();

  for (const name of names) {
    if (name.startsWith(".")) continue; // グロブ "*" はドットファイルに一致しない
    const full = path.join(device.sourceDir, name);

    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    // 履歴チェック (デバイス名:ファイル名 で照合)
    if (ctx.imported.has(`${device.name}:${name}`)) continue;

    // 除外パターン
    if (excludes.some((re) => re.test(name))) continue;

    // 正規表現による日付・時刻抽出
    const match = device.dateRegex.exec(name);
    if (!match) continue;
    const [, dpart = "", tpart = ""] = match;
    if (!/^[0-9]{8}$/.test(dpart) || !/^[0-9]{6}$/.test(tpart)) continue;

    const date = calculateShootingDate(dpart, tpart, settings.cutoffHHMM);
    if (!date) continue;

    const list = byDate.get(date) ?? [];
    list.push({ path: full, name, size: stat.size, date });
    byDate.set(date, list);
  }

  const groups: DateGroup[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const files = byDate.get(date) ?? [];
    groups.push({
      id: `${device.name}|${date}`,
      device,
      date,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      existing: await findExistingProjects(ctx.footageRoot, date),
    });
  }
  return groups;
}
