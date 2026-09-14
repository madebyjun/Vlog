import * as fs from "node:fs/promises";
import path from "node:path";
import { ASSETS_SUBPATH, HISTORY_FILENAME, SSD_SUBPATH, TEMPLATE_SUBPATH } from "./config";
import { run } from "./shell";

export interface SsdContext {
  uuid: string;
  mount: string;
  footageRoot: string;
  templateDir: string;
  assetsDir: string;
  historyFile: string;
  /** "デバイス名:ファイル名" の集合 */
  imported: Set<string>;
  /** 履歴ファイルの行数 (wc -l 相当) */
  historyCount: number;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** SSD をUUIDで特定し、保存先フォルダと履歴ファイルを準備する */
export async function prepareSsd(uuid: string): Promise<SsdContext> {
  let info = "";
  try {
    info = (await run("/usr/sbin/diskutil", ["info", uuid])).stdout;
  } catch {
    info = "";
  }
  if (!info.trim()) {
    throw new Error("保存先 SSD が見つかりません。");
  }

  const mountLine = info.split("\n").find((line) => line.includes("Mount Point"));
  const mount = mountLine ? mountLine.slice(mountLine.indexOf(":") + 1).trim() : "";
  if (!mount) {
    throw new Error("保存先 SSD がマウントされていません。");
  }

  const footageRoot = path.join(mount, SSD_SUBPATH);
  const templateDir = path.join(mount, TEMPLATE_SUBPATH);
  const assetsDir = path.join(mount, ASSETS_SUBPATH);

  if (!(await isDirectory(footageRoot))) {
    throw new Error(`保存先フォルダが見つかりません: ${footageRoot}`);
  }

  const historyFile = path.join(footageRoot, HISTORY_FILENAME);
  try {
    const handle = await fs.open(historyFile, "a");
    await handle.close();
  } catch {
    throw new Error(`履歴ファイルを作成できませんでした: ${historyFile}`);
  }

  const content = await fs.readFile(historyFile, "utf8");
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const historyCount = (content.match(/\n/g) ?? []).length;

  return {
    uuid,
    mount,
    footageRoot,
    templateDir,
    assetsDir,
    historyFile,
    imported: new Set(lines),
    historyCount,
  };
}

/** SSD の空きバイト数を返す (df -Pk 相当)。取得できなければ例外 */
export async function getFreeBytes(mount: string): Promise<number> {
  let stdout = "";
  try {
    stdout = (await run("/bin/df", ["-Pk", mount])).stdout;
  } catch {
    stdout = "";
  }
  const line = stdout.split("\n")[1] ?? "";
  const freeKb = line.trim().split(/\s+/)[3] ?? "";
  if (!/^[0-9]+$/.test(freeKb)) {
    throw new Error("SSDの空き容量を取得できませんでした。");
  }
  return Number(freeKb) * 1024;
}
