import { TIER_LABELS, Tier } from "./config";
import type { DateGroup } from "./scan";
import type { Settings } from "./settings";

/** 日付ごとの転送先の決定内容 (スクリプトの対話入力に相当) */
export type Plan =
  | { kind: "existing"; projectDir: string; projectName: string }
  | { kind: "new"; title: string; tier: Tier }
  | { kind: "skip" };

export function describePlan(plan: Plan | undefined): string {
  if (!plan) return "未決定";
  switch (plan.kind) {
    case "existing":
      return `既存: ${plan.projectName}`;
    case "new":
      return `新規: ${TIER_LABELS[plan.tier]} / ${plan.title}`;
    case "skip":
      return "スキップ";
  }
}

/**
 * スキャン直後の初期プラン。
 * 既存プロジェクトが 1 つならそれ、無ければ既定のタイトル・Tier で新規作成。
 * 2 つ以上あるときはどれを使うか決められないので未決定にする。
 */
export function suggestPlan(
  group: DateGroup,
  settings: Pick<Settings, "defaultTitle" | "defaultTier">,
): Plan | undefined {
  if (group.existing.length === 1) {
    const [p] = group.existing;
    return { kind: "existing", projectDir: p.path, projectName: p.name };
  }
  if (group.existing.length === 0) {
    return { kind: "new", title: settings.defaultTitle, tier: settings.defaultTier };
  }
  return undefined;
}
