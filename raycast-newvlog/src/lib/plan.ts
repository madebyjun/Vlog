import { Tier } from "./config";

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
      return `新規: ${plan.tier} / ${plan.title}`;
    case "skip":
      return "スキップ";
  }
}
