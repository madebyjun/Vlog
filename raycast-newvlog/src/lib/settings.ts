// ユーザー設定。Support フォルダの settings.json に保存し、設定画面 (configure) から変更する。
// UI・ワーカー・E2E から共通で使うため、@raycast/api には依存しないこと。

import * as fs from "node:fs";
import path from "node:path";
import { DEFAULT_EXCLUDE_PATTERNS, Tier, isTier } from "./config";
import { writeFileAtomicSync } from "./job";

export interface Settings {
  ssdUuid: string;
  /** "HH:MM" */
  cutoffTime: string;
  /** "HHMM" (比較用) */
  cutoffHHMM: string;
  spaceMarginGb: number;
  spaceMarginBytes: number;
  defaultTitle: string;
  defaultTier: Tier;
  /** zsh のグロブパターン */
  excludePatterns: string[];
  openInFinder: boolean;
  /** 転送完了時に macOS の通知を出す */
  notify: boolean;
}

/** フォームの入力値 (すべて文字列・真偽値のまま) */
export interface SettingsInput {
  ssdUuid: string;
  cutoffTime: string;
  spaceMarginGb: string;
  defaultTitle: string;
  defaultTier: string;
  /** カンマ区切り */
  excludePatterns: string;
  openInFinder: boolean;
  notify: boolean;
}

export type SettingsErrors = Partial<Record<keyof SettingsInput, string>>;

export const DEFAULT_INPUT: SettingsInput = {
  ssdUuid: "",
  cutoffTime: "04:00",
  spaceMarginGb: "2",
  defaultTitle: "NewProject",
  defaultTier: "TIER_2__STORE",
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS.join(", "),
  openInFinder: true,
  notify: true,
};

// ---------- 検証 ----------

type TextField = Exclude<keyof SettingsInput, "openInFinder" | "notify">;

/** 項目ごとの検証。問題があればエラーメッセージを返す (フォームのインライン検証でも使う) */
export const FIELD_VALIDATORS: Record<TextField, (value: string | undefined) => string | undefined> = {
  ssdUuid: (v = "") => (v.trim() === "" ? "保存先のSSDを選んでください" : undefined),
  cutoffTime: (v = "") =>
    /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v.trim()) ? undefined : "HH:MM 形式で入力してください",
  spaceMarginGb: (v = "") => {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? undefined : "0 以上の数値 (GB) を入力してください";
  },
  defaultTitle: (v = "") => (v.includes("/") ? "/ は使えません" : undefined),
  defaultTier: (v = "") => (isTier(v) ? undefined : "Tier を選んでください"),
  excludePatterns: (v = "") =>
    splitPatterns(v).some((p) => p.includes("/")) ? "パターンに / は使えません" : undefined,
};

function splitPatterns(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function validateSettings(input: SettingsInput): { settings?: Settings; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  for (const key of Object.keys(FIELD_VALIDATORS) as TextField[]) {
    const error = FIELD_VALIDATORS[key](input[key]);
    if (error) errors[key] = error;
  }
  if (Object.keys(errors).length > 0) return { errors };

  const cutoffTime = input.cutoffTime.trim();
  const spaceMarginGb = Number(input.spaceMarginGb.trim());
  return {
    errors,
    settings: {
      ssdUuid: input.ssdUuid.trim(),
      cutoffTime,
      cutoffHHMM: cutoffTime.replace(":", ""),
      spaceMarginGb,
      spaceMarginBytes: Math.round(spaceMarginGb * 1024 * 1024 * 1024),
      defaultTitle: input.defaultTitle.trim() || DEFAULT_INPUT.defaultTitle,
      defaultTier: input.defaultTier as Tier,
      excludePatterns: splitPatterns(input.excludePatterns),
      openInFinder: input.openInFinder,
      notify: input.notify,
    },
  };
}

export function settingsToInput(settings: Settings): SettingsInput {
  return {
    ssdUuid: settings.ssdUuid,
    cutoffTime: settings.cutoffTime,
    spaceMarginGb: String(settings.spaceMarginGb),
    defaultTitle: settings.defaultTitle,
    defaultTier: settings.defaultTier,
    excludePatterns: settings.excludePatterns.join(", "),
    openInFinder: settings.openInFinder,
    notify: settings.notify,
  };
}

// ---------- 保存・読み込み ----------

export function settingsFile(supportPath: string): string {
  return path.join(supportPath, "settings.json");
}

/** 保存形式 (手で編集されることもあるので、読むときは型を信用しない) */
interface StoredSettings {
  ssdUuid?: unknown;
  cutoffTime?: unknown;
  spaceMarginGb?: unknown;
  defaultTitle?: unknown;
  defaultTier?: unknown;
  excludePatterns?: unknown;
  openInFinder?: unknown;
  notify?: unknown;
}

export type LoadedSettings =
  /** まだ設定していない (ファイルが無い・読めない・SSD 未選択) */
  | { kind: "missing"; input: SettingsInput }
  /** 保存されている値が不正 (手で編集された等) */
  | { kind: "invalid"; input: SettingsInput; errors: SettingsErrors }
  | { kind: "ok"; input: SettingsInput; settings: Settings };

/** 保存値をフォーム入力値に直す。欠けている項目は既定値で補う */
function storedToInput(stored: StoredSettings): SettingsInput {
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    ssdUuid: str(stored.ssdUuid, DEFAULT_INPUT.ssdUuid),
    cutoffTime: str(stored.cutoffTime, DEFAULT_INPUT.cutoffTime),
    spaceMarginGb:
      typeof stored.spaceMarginGb === "number"
        ? String(stored.spaceMarginGb)
        : str(stored.spaceMarginGb, DEFAULT_INPUT.spaceMarginGb),
    defaultTitle: str(stored.defaultTitle, DEFAULT_INPUT.defaultTitle),
    defaultTier: str(stored.defaultTier, DEFAULT_INPUT.defaultTier),
    excludePatterns: Array.isArray(stored.excludePatterns)
      ? stored.excludePatterns.filter((p): p is string => typeof p === "string").join(", ")
      : str(stored.excludePatterns, DEFAULT_INPUT.excludePatterns),
    openInFinder: bool(stored.openInFinder, DEFAULT_INPUT.openInFinder),
    notify: bool(stored.notify, DEFAULT_INPUT.notify),
  };
}

export function loadSettingsFrom(file: string): LoadedSettings {
  let stored: StoredSettings;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    stored = parsed as StoredSettings;
  } catch {
    return { kind: "missing", input: { ...DEFAULT_INPUT } };
  }
  const input = storedToInput(stored);
  if (input.ssdUuid.trim() === "") return { kind: "missing", input };
  const { settings, errors } = validateSettings(input);
  if (!settings) return { kind: "invalid", input, errors };
  return { kind: "ok", input, settings };
}

/** 検証済みの設定をアトミックに保存する */
export function saveSettingsTo(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stored = {
    ssdUuid: settings.ssdUuid,
    cutoffTime: settings.cutoffTime,
    spaceMarginGb: settings.spaceMarginGb,
    defaultTitle: settings.defaultTitle,
    defaultTier: settings.defaultTier,
    excludePatterns: settings.excludePatterns,
    openInFinder: settings.openInFinder,
    notify: settings.notify,
  };
  writeFileAtomicSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}
