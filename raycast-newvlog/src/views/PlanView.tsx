import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  confirmAlert,
  environment,
  showToast,
  Toast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import path from "node:path";
import { ReactNode, useMemo, useState } from "react";
import { SpaceInfo, computeSpaceInfo } from "../lib/engine";
import { formatGib } from "../lib/format";
import { startJob } from "../lib/job";
import { nodeBinaryPath, raycastJobPaths, workerScriptPath } from "../lib/runtime";
import { getFreeBytes } from "../lib/ssd";
import { Plan, describePlan } from "../lib/plan";
import { DateGroup } from "../lib/scan";
import { NewProjectForm } from "./NewProjectForm";
import { ScanData } from "./ScanView";
import { TransferView } from "./TransferView";

interface Props {
  data: ScanData;
  onRescan: () => void;
}

function planIcon(plan: Plan | undefined): List.Item.Props["icon"] {
  if (!plan) return { source: Icon.QuestionMarkCircle, tintColor: Color.Orange };
  switch (plan.kind) {
    case "existing":
      return { source: Icon.Folder, tintColor: Color.Blue };
    case "new":
      return { source: Icon.NewFolder, tintColor: Color.Green };
    case "skip":
      return { source: Icon.Forward, tintColor: Color.SecondaryText };
  }
}

function planTag(plan: Plan | undefined): { value: string; color: Color } {
  if (!plan) return { value: "未決定", color: Color.Orange };
  switch (plan.kind) {
    case "existing":
      return { value: "既存", color: Color.Blue };
    case "new":
      return { value: `新規 · ${plan.tier}`, color: Color.Green };
    case "skip":
      return { value: "スキップ", color: Color.SecondaryText };
  }
}

/** 容量不足時の確認ダイアログ (スクリプトの [1]中止 / [2]このまま転送 に相当) */
async function confirmSpace(info: SpaceInfo): Promise<boolean> {
  const lines = [
    `転送予定: ${formatGib(info.totalBytes)} (${info.fileCount}ファイル)`,
    `安全マージン: ${formatGib(info.marginBytes)}`,
    `必要空き容量: ${formatGib(info.requiredBytes)}`,
    `現在の空き容量: ${formatGib(info.freeBytes)}`,
    `追加で必要: ${formatGib(info.shortageBytes)}`,
  ];
  return confirmAlert({
    icon: { source: Icon.Warning, tintColor: Color.Orange },
    title: info.insufficient
      ? `[${info.deviceName}] SSDの空き容量が不足しています`
      : `[${info.deviceName}] 安全マージンを確保できません`,
    message: lines.join("\n"),
    primaryAction: { title: "このまま転送を開始する (入るところまで)", style: Alert.ActionStyle.Destructive },
    dismissAction: { title: "中止する" },
  });
}

export function PlanView({ data, onRescan }: Props) {
  const { push } = useNavigation();
  const [plans, setPlans] = useState<Record<string, Plan>>({});

  const setPlan = (id: string, plan: Plan | undefined) => {
    setPlans((prev) => {
      const next = { ...prev };
      if (plan) next[id] = plan;
      else delete next[id];
      return next;
    });
  };

  const summary = useMemo(() => {
    const totalFiles = data.groups.reduce((s, g) => s + g.files.length, 0);
    const totalBytes = data.groups.reduce((s, g) => s + g.totalBytes, 0);
    const planned = data.groups.filter((g) => plans[g.id] && plans[g.id].kind !== "skip");
    const plannedBytes = planned.reduce((s, g) => s + g.totalBytes, 0);
    const plannedFiles = planned.reduce((s, g) => s + g.files.length, 0);
    const unplanned = data.groups.filter((g) => !plans[g.id]).length;
    const required = totalBytes + data.settings.spaceMarginBytes;
    return { totalFiles, totalBytes, plannedBytes, plannedFiles, unplanned, required };
  }, [data, plans]);

  const startTransfer = async () => {
    if (summary.unplanned > 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: `未決定の日付が ${summary.unplanned} 件あります`,
        message: "各日付で「既存を使用」「新規作成」「スキップ」のいずれかを選んでください",
      });
      return;
    }
    if (summary.plannedFiles === 0) {
      await showToast({ style: Toast.Style.Failure, title: "転送対象がありません (すべてスキップ)" });
      return;
    }
    const ok = await confirmAlert({
      icon: Icon.Upload,
      title: "転送を開始しますか？",
      message: `${summary.plannedFiles}ファイル / ${formatGib(summary.plannedBytes)} を転送します。\n転送はバックグラウンドで行われるので、Raycast を閉じても大丈夫です。`,
      primaryAction: { title: "転送を開始" },
      dismissAction: { title: "キャンセル" },
    });
    if (!ok) return;

    try {
      const approvedSpaceDevices = await confirmSpaceUpfront();
      if (!approvedSpaceDevices) return;

      const paths = raycastJobPaths();
      await startJob({
        paths,
        workerScript: workerScriptPath(),
        nodePath: nodeBinaryPath(),
        spec: {
          input: {
            ctx: data.ctx,
            settings: data.settings,
            devices: data.devices,
            groups: data.groups,
            plans,
            logDir: path.join(environment.supportPath, "logs"),
          },
          approvedSpaceDevices,
          notify: true,
        },
      });
      push(<TransferView paths={paths} onRestart={onRescan} />);
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "転送を開始できません",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * 転送中は確認ダイアログを出せないため、容量チェックを開始前に見積もりで行う。
   * 前のデバイスの転送で空きが減る分も織り込む。承認したデバイス名を返し、中止なら null。
   */
  const confirmSpaceUpfront = async (): Promise<string[] | null> => {
    let freeBytes = await getFreeBytes(data.ctx.mount);
    const approved: string[] = [];
    for (const device of data.devices) {
      const deviceGroups = data.groups.filter((g) => g.device.name === device.name);
      if (deviceGroups.length === 0) continue;
      const info = computeSpaceInfo(device.name, deviceGroups, data.settings.spaceMarginBytes, freeBytes);
      if (info) {
        if (!(await confirmSpace(info))) return null;
        approved.push(device.name);
      }
      const transferring = deviceGroups.filter((g) => plans[g.id] && plans[g.id].kind !== "skip");
      freeBytes -= transferring.reduce((s, g) => s + g.totalBytes, 0);
    }
    return approved;
  };

  const spaceWarning = summary.required > data.freeBytes;

  const commonActions = (
    <ActionPanel.Section title="全体">
      <Action
        title="転送を開始"
        icon={Icon.Upload}
        shortcut={{ modifiers: ["cmd"], key: "return" }}
        onAction={() => void startTransfer()}
      />
      <Action
        title="再スキャン"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={onRescan}
      />
    </ActionPanel.Section>
  );

  return (
    <List isShowingDetail navigationTitle="転送プラン" searchBarPlaceholder="日付・デバイスで絞り込み">
      <List.Section title="概要">
        <List.Item
          title="転送サマリ"
          icon={{
            source: spaceWarning ? Icon.Warning : Icon.HardDrive,
            tintColor: spaceWarning ? Color.Orange : Color.Blue,
          }}
          accessories={[
            {
              tag: { value: `未決定 ${summary.unplanned}`, color: summary.unplanned > 0 ? Color.Orange : Color.Green },
            },
          ]}
          detail={
            <List.Item.Detail
              markdown={[
                `## ${spaceWarning ? "⚠️ 空き容量に注意" : "✅ SSD準備完了"}`,
                "",
                `履歴: ${data.ctx.historyCount}件`,
                "",
                "### 🔎 検出されたデバイス",
                ...data.devices.map((d) => `- ✅ **${d.name}**  \`${d.sourceDir}\``),
                "",
                "### 📋 使い方",
                "1. 各日付を選び、`⌘K` から「既存プロジェクトを使用」「新規プロジェクトを作成」「スキップ」を選択",
                "2. すべての日付が決まったら `⌘↩` で転送を開始",
                "",
                spaceWarning
                  ? "> 転送予定 + 安全マージンが空き容量を超えています。転送開始前にデバイスごとに確認します。"
                  : "",
              ].join("\n")}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="SSD" text={data.ctx.mount} />
                  <List.Item.Detail.Metadata.Label title="保存先" text={data.ctx.footageRoot} />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label
                    title="転送対象 (全体)"
                    text={`${summary.totalFiles}ファイル / ${formatGib(summary.totalBytes)}`}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="転送対象 (プラン済み)"
                    text={`${summary.plannedFiles}ファイル / ${formatGib(summary.plannedBytes)}`}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="安全マージン"
                    text={formatGib(data.settings.spaceMarginBytes)}
                  />
                  <List.Item.Detail.Metadata.Label title="必要空き容量" text={formatGib(summary.required)} />
                  <List.Item.Detail.Metadata.Label
                    title="現在の空き容量"
                    text={formatGib(data.freeBytes)}
                    icon={spaceWarning ? { source: Icon.Warning, tintColor: Color.Orange } : undefined}
                  />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label title="日付切り替え時刻" text={data.settings.cutoffTime} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={<ActionPanel>{commonActions}</ActionPanel>}
        />
      </List.Section>

      {data.devices.map((device) => {
        const groups = data.groups.filter((g) => g.device.name === device.name);
        return (
          <List.Section key={device.name} title={device.name} subtitle={device.sourceDir}>
            {groups.map((group) => (
              <GroupItem
                key={group.id}
                group={group}
                plan={plans[group.id]}
                defaultTitle={data.settings.defaultTitle}
                onPlanChange={(plan) => setPlan(group.id, plan)}
                commonActions={commonActions}
              />
            ))}
          </List.Section>
        );
      })}
    </List>
  );
}

interface GroupItemProps {
  group: DateGroup;
  plan: Plan | undefined;
  defaultTitle: string;
  onPlanChange: (plan: Plan | undefined) => void;
  commonActions: ReactNode;
}

function GroupItem({ group, plan, defaultTitle, onPlanChange, commonActions }: GroupItemProps) {
  const previewLimit = 40;
  const fileLines = group.files.slice(0, previewLimit).map((f) => `- ${f.name}  _(${formatGib(f.size)})_`);
  if (group.files.length > previewLimit) fileLines.push(`- … 他 ${group.files.length - previewLimit} ファイル`);

  const existingLines =
    group.existing.length > 0
      ? group.existing.map((p) => `- ${p.tier} / **${p.name}**`)
      : ["- (なし → 新規作成のみ選択可能)"];

  const tag = planTag(plan);

  return (
    <List.Item
      title={group.date}
      subtitle={`${group.files.length}ファイル · ${formatGib(group.totalBytes)}`}
      keywords={[group.device.name, group.date.replace(/-/g, "")]}
      icon={planIcon(plan)}
      accessories={[{ tag }]}
      detail={
        <List.Item.Detail
          markdown={[
            `## 📅 ${group.date}  —  ${group.device.name}`,
            "",
            `**プラン:** ${describePlan(plan)}`,
            "",
            "### ⚡️ 既存プロジェクト",
            ...existingLines,
            "",
            `### 📄 転送対象ファイル (${group.files.length})`,
            ...fileLines,
          ].join("\n")}
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="デバイス" text={group.device.name} />
              <List.Item.Detail.Metadata.Label title="転送先サブフォルダ" text={group.device.destFolderName} />
              <List.Item.Detail.Metadata.Label title="ファイル数" text={String(group.files.length)} />
              <List.Item.Detail.Metadata.Label title="サイズ" text={formatGib(group.totalBytes)} />
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.TagList title="プラン">
                <List.Item.Detail.Metadata.TagList.Item text={tag.value} color={tag.color} />
              </List.Item.Detail.Metadata.TagList>
              {plan?.kind === "existing" && (
                <List.Item.Detail.Metadata.Label title="プロジェクト" text={plan.projectDir} />
              )}
              {plan?.kind === "new" && (
                <List.Item.Detail.Metadata.Label title="作成先" text={`${plan.tier}/${group.date}-${plan.title}`} />
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title={`${group.date} のプラン`}>
            {group.existing.length > 0 && (
              <ActionPanel.Submenu title="既存プロジェクトを使用" icon={Icon.Folder}>
                {group.existing.map((p) => (
                  <Action
                    key={p.path}
                    title={`${p.tier} / ${p.name}`}
                    icon={Icon.Folder}
                    onAction={() => onPlanChange({ kind: "existing", projectDir: p.path, projectName: p.name })}
                  />
                ))}
              </ActionPanel.Submenu>
            )}
            <Action.Push
              title="新規プロジェクトを作成"
              icon={Icon.NewFolder}
              shortcut={Keyboard.Shortcut.Common.New}
              target={
                <NewProjectForm
                  group={group}
                  defaultTitle={defaultTitle}
                  initial={plan?.kind === "new" ? { title: plan.title, tier: plan.tier } : undefined}
                  onSubmit={onPlanChange}
                />
              }
            />
            <Action
              title="この日付をスキップ"
              icon={Icon.Forward}
              shortcut={Keyboard.Shortcut.Common.Save}
              onAction={() => onPlanChange({ kind: "skip" })}
            />
            {plan && (
              <Action
                title="未決定に戻す"
                icon={Icon.Undo}
                shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                onAction={() => onPlanChange(undefined)}
              />
            )}
          </ActionPanel.Section>
          {commonActions}
        </ActionPanel>
      }
    />
  );
}
