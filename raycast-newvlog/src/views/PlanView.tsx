import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Image,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  useNavigation,
  showToast,
} from "@raycast/api";
import path from "node:path";
import { ReactNode, useMemo, useState } from "react";
import { TIER_LABELS } from "../lib/config";
import { SpaceInfo, computeSpaceInfo } from "../lib/engine";
import { formatGib } from "../lib/format";
import { startJob } from "../lib/job";
import { Plan, applyPlan, describePlan, samePlan, suggestPlan } from "../lib/plan";
import { logDirPath, nodeBinaryPath, raycastJobPaths, refreshMenuBar, workerScriptPath } from "../lib/runtime";
import { DateGroup } from "../lib/scan";
import { getFreeBytes } from "../lib/ssd";
import { DestinationPicker } from "./DestinationPicker";
import { NewProjectForm } from "./NewProjectForm";
import { ScanData } from "./ScanView";
import { SettingsForm } from "./SettingsForm";

interface Props {
  data: ScanData;
  onRescan: () => void;
  /** 転送ジョブを起動した (ルートを進捗画面に切り替える) */
  onStarted: () => void;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function withWeekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Number.isNaN(day) ? date : `${date} (${WEEKDAYS[day]})`;
}

function planIcon(plan: Plan | undefined): Image.ImageLike {
  if (!plan) return { source: Icon.QuestionMarkCircle, tintColor: Color.Orange };
  switch (plan.kind) {
    case "existing":
      return { source: Icon.Folder, tintColor: Color.Blue };
    case "new":
      return { source: Icon.NewFolder, tintColor: Color.Green };
    case "skip":
      return { source: Icon.MinusCircle, tintColor: Color.SecondaryText };
  }
}

function planTag(plan: Plan | undefined): { value: string; color: Color } {
  if (!plan) return { value: "未決定", color: Color.Orange };
  switch (plan.kind) {
    case "existing":
      return { value: "既存", color: Color.Blue };
    case "new":
      return { value: `新規 · ${TIER_LABELS[plan.tier]}`, color: Color.Green };
    case "skip":
      return { value: "スキップ", color: Color.SecondaryText };
  }
}

function isTransferring(plan: Plan | undefined): boolean {
  return plan !== undefined && plan.kind !== "skip";
}

/**
 * 転送中は確認ダイアログを出せないため、容量チェックを開始前に見積もりで行う。
 * 前のデバイスの転送で空きが減る分も織り込む。
 */
async function estimateSpace(data: ScanData, plans: Record<string, Plan>): Promise<SpaceInfo[]> {
  let freeBytes = await getFreeBytes(data.ctx.mount);
  const issues: SpaceInfo[] = [];
  for (const device of data.devices) {
    // エンジンと同じく、スキップする日付は含めない
    const deviceGroups = data.groups.filter((g) => g.device.name === device.name && isTransferring(plans[g.id]));
    if (deviceGroups.length === 0) continue;
    const info = computeSpaceInfo(device.name, deviceGroups, data.settings.spaceMarginBytes, freeBytes);
    if (info) issues.push(info);
    freeBytes -= deviceGroups.reduce((s, g) => s + g.totalBytes, 0);
  }
  return issues;
}

export function PlanView({ data, onRescan, onStarted }: Props) {
  const { settings } = data;
  const suggestions = useMemo(() => {
    const result: Record<string, Plan> = {};
    for (const g of data.groups) {
      const plan = suggestPlan(g, settings);
      if (plan) result[g.id] = plan;
    }
    return result;
  }, [data, settings]);
  const [plans, setPlans] = useState<Record<string, Plan>>(suggestions);
  const [starting, setStarting] = useState(false);

  const { pop } = useNavigation();

  const setPlan = (id: string, plan: Plan | undefined) => {
    setPlans((prev) => applyPlan(prev, data.groups, id, plan));
  };

  const summary = useMemo(() => {
    const planned = data.groups.filter((g) => isTransferring(plans[g.id]));
    return {
      plannedFiles: planned.reduce((s, g) => s + g.files.length, 0),
      plannedBytes: planned.reduce((s, g) => s + g.totalBytes, 0),
      plannedDays: planned.length,
      unplanned: data.groups.filter((g) => !plans[g.id]).length,
    };
  }, [data, plans]);

  const requiredBytes = summary.plannedBytes + settings.spaceMarginBytes;
  const spaceShort = requiredBytes > data.freeBytes;

  const startTransfer = async () => {
    if (starting) return;
    if (summary.unplanned > 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: `転送先が決まっていない日付が ${summary.unplanned} 件あります`,
      });
      return;
    }
    if (summary.plannedFiles === 0) {
      await showToast({ style: Toast.Style.Failure, title: "転送するファイルがありません" });
      return;
    }

    setStarting(true);
    try {
      const issues = await estimateSpace(data, plans);
      const base = `${summary.plannedFiles}ファイル (${formatGib(summary.plannedBytes)}) を転送します。Raycast を閉じても転送は続きます。`;
      const ok = await confirmAlert(
        issues.length === 0
          ? {
              icon: Icon.Upload,
              title: "転送を開始しますか？",
              message: base,
              primaryAction: { title: "転送を開始" },
              dismissAction: { title: "キャンセル" },
            }
          : {
              icon: { source: Icon.Warning, tintColor: Color.Orange },
              title: issues.some((i) => i.insufficient) ? "SSDの空き容量が足りません" : "安全マージンを確保できません",
              message: [
                base,
                "",
                ...issues.map(
                  (i) =>
                    `${i.deviceName}: 必要 ${formatGib(i.requiredBytes)} / 空き ${formatGib(i.freeBytes)} (不足 ${formatGib(i.shortageBytes)})`,
                ),
                "",
                "続けると、入るところまで転送します。",
              ].join("\n"),
              primaryAction: { title: "このまま転送", style: Alert.ActionStyle.Destructive },
              dismissAction: { title: "キャンセル" },
            },
      );
      if (!ok) return;

      await startJob({
        paths: raycastJobPaths(),
        workerScript: workerScriptPath(),
        nodePath: nodeBinaryPath(),
        spec: {
          input: {
            ctx: data.ctx,
            settings,
            devices: data.devices,
            groups: data.groups,
            plans,
            logDir: logDirPath(),
          },
          approvedSpaceDevices: issues.map((i) => i.deviceName),
          notify: settings.notify,
        },
      });
      await refreshMenuBar();
      onStarted();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "転送を開始できません",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  const commonActions = (
    <ActionPanel.Section>
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
      <Action.Push
        title="設定"
        icon={Icon.Gear}
        shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
        target={
          <SettingsForm
            onSaved={() => {
              pop();
              onRescan();
            }}
          />
        }
      />
    </ActionPanel.Section>
  );

  const ssdName = path.basename(data.ctx.mount);

  return (
    <List
      isShowingDetail
      isLoading={starting}
      navigationTitle="転送プラン"
      searchBarPlaceholder="日付・デバイスで絞り込み"
    >
      <List.Section title="転送">
        <List.Item
          title="転送を開始"
          subtitle={`${summary.plannedDays}日分 · ${summary.plannedFiles}ファイル · ${formatGib(summary.plannedBytes)}`}
          icon={{
            source: spaceShort ? Icon.Warning : Icon.Upload,
            tintColor: spaceShort ? Color.Orange : summary.unplanned > 0 ? Color.SecondaryText : Color.Blue,
          }}
          keywords={["start", "transfer"]}
          accessories={[
            ...(summary.unplanned > 0 ? [{ tag: { value: `未決定 ${summary.unplanned}`, color: Color.Orange } }] : []),
            ...(spaceShort ? [{ tag: { value: "容量不足", color: Color.Orange } }] : []),
          ]}
          detail={
            <List.Item.Detail
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="転送する日付" text={`${summary.plannedDays} 日分`} />
                  <List.Item.Detail.Metadata.Label title="ファイル" text={`${summary.plannedFiles}`} />
                  <List.Item.Detail.Metadata.Label title="サイズ" text={formatGib(summary.plannedBytes)} />
                  {summary.unplanned > 0 && (
                    <List.Item.Detail.Metadata.Label
                      title="未決定"
                      text={`${summary.unplanned} 件 — 日付を選んで Enter で転送先を決めてください`}
                      icon={{ source: Icon.QuestionMarkCircle, tintColor: Color.Orange }}
                    />
                  )}
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label title="保存先SSD" text={ssdName} icon={Icon.HardDrive} />
                  <List.Item.Detail.Metadata.Label
                    title="空き容量"
                    text={formatGib(data.freeBytes)}
                    icon={spaceShort ? { source: Icon.Warning, tintColor: Color.Orange } : undefined}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="必要な空き容量"
                    text={`${formatGib(requiredBytes)} (マージン ${formatGib(settings.spaceMarginBytes)} を含む)`}
                  />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.TagList title="デバイス">
                    {data.devices.map((d) => (
                      <List.Item.Detail.Metadata.TagList.Item key={d.name} text={d.name} />
                    ))}
                  </List.Item.Detail.Metadata.TagList>
                  <List.Item.Detail.Metadata.Label
                    title="日付の切り替え"
                    text={`${settings.cutoffTime} より前は前日扱い`}
                  />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={<ActionPanel>{commonActions}</ActionPanel>}
        />
      </List.Section>

      {data.devices.map((device) => {
        const groups = data.groups.filter((g) => g.device.name === device.name);
        if (groups.length === 0) return null;
        const bytes = groups.reduce((s, g) => s + g.totalBytes, 0);
        return (
          <List.Section key={device.name} title={device.name} subtitle={`${groups.length}日 · ${formatGib(bytes)}`}>
            {groups.map((group) => (
              <GroupItem
                key={group.id}
                group={group}
                plan={plans[group.id]}
                sharedWith={data.groups
                  .filter(
                    (g) =>
                      g.id !== group.id &&
                      g.date === group.date &&
                      isTransferring(plans[group.id]) &&
                      samePlan(plans[g.id], plans[group.id]),
                  )
                  .map((g) => g.device.name)}
                suggestion={suggestions[group.id]}
                data={data}
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
  /** 同じプロジェクトに入る、同じ撮影日の別デバイス */
  sharedWith: string[];
  suggestion: Plan | undefined;
  data: ScanData;
  onPlanChange: (plan: Plan | undefined) => void;
  commonActions: ReactNode;
}

function fileTypes(group: DateGroup): string {
  const counts = new Map<string, number>();
  for (const f of group.files) {
    const ext = path.extname(f.name).slice(1).toUpperCase() || "?";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts].map(([ext, n]) => `${ext} ×${n}`).join(" · ");
}

function destinationText(group: DateGroup, plan: Plan | undefined, footageRoot: string): string {
  if (!plan) return "—";
  switch (plan.kind) {
    case "existing":
      return path.relative(footageRoot, plan.projectDir);
    case "new":
      return `${plan.tier}/${group.date}-${plan.title}`;
    case "skip":
      return "転送しない";
  }
}

function GroupItem({ group, plan, sharedWith, suggestion, data, onPlanChange, commonActions }: GroupItemProps) {
  const { settings } = data;
  const tag = planTag(plan);
  const times = group.files.map((f) => f.time).sort();
  const isSuggested = plan !== undefined && JSON.stringify(plan) === JSON.stringify(suggestion);

  return (
    <List.Item
      title={withWeekday(group.date)}
      subtitle={`${group.files.length}ファイル · ${formatGib(group.totalBytes)}`}
      keywords={[group.device.name, group.date.replace(/-/g, ""), ...(plan ? [describePlan(plan)] : [])]}
      icon={planIcon(plan)}
      accessories={[{ tag, tooltip: describePlan(plan) }]}
      detail={
        <List.Item.Detail
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.TagList title="転送先">
                <List.Item.Detail.Metadata.TagList.Item text={tag.value} color={tag.color} />
                {isSuggested && <List.Item.Detail.Metadata.TagList.Item text="自動で選択" />}
              </List.Item.Detail.Metadata.TagList>
              <List.Item.Detail.Metadata.Label
                title="プロジェクト"
                text={destinationText(group, plan, data.ctx.footageRoot)}
              />
              {plan && plan.kind !== "skip" && (
                <List.Item.Detail.Metadata.Label title="サブフォルダ" text={group.device.destFolderName} />
              )}
              {sharedWith.length > 0 && (
                <List.Item.Detail.Metadata.Label
                  title="同じプロジェクト"
                  text={`${sharedWith.join("、")} も同じフォルダに入ります`}
                  icon={Icon.Link}
                />
              )}
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label title="デバイス" text={group.device.name} />
              <List.Item.Detail.Metadata.Label title="ファイル" text={`${group.files.length} (${fileTypes(group)})`} />
              <List.Item.Detail.Metadata.Label title="サイズ" text={formatGib(group.totalBytes)} />
              {times.length > 0 && (
                <List.Item.Detail.Metadata.Label title="撮影時刻" text={`${times[0]} – ${times[times.length - 1]}`} />
              )}
              <List.Item.Detail.Metadata.Separator />
              {group.existing.length === 0 ? (
                <List.Item.Detail.Metadata.Label title="既存のプロジェクト" text="なし" />
              ) : (
                <List.Item.Detail.Metadata.TagList title="既存のプロジェクト">
                  {group.existing.map((p) => (
                    <List.Item.Detail.Metadata.TagList.Item
                      key={p.path}
                      text={`${TIER_LABELS[p.tier]} / ${p.name}`}
                      color={plan?.kind === "existing" && plan.projectDir === p.path ? Color.Blue : undefined}
                    />
                  ))}
                </List.Item.Detail.Metadata.TagList>
              )}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title={group.date}>
            <Action.Push
              title="転送先を選択…"
              icon={Icon.Folder}
              target={
                <DestinationPicker
                  group={group}
                  plan={plan}
                  defaultTitle={settings.defaultTitle}
                  defaultTier={settings.defaultTier}
                  onChange={onPlanChange}
                />
              }
            />
            <Action.Push
              title="新規プロジェクトを作成…"
              icon={Icon.NewFolder}
              shortcut={Keyboard.Shortcut.Common.New}
              target={
                <NewProjectForm
                  group={group}
                  defaultTitle={settings.defaultTitle}
                  defaultTier={settings.defaultTier}
                  initial={plan?.kind === "new" ? { title: plan.title, tier: plan.tier } : undefined}
                  onSubmit={onPlanChange}
                />
              }
            />
            {plan?.kind !== "skip" && (
              <Action
                title="スキップ"
                icon={Icon.MinusCircle}
                shortcut={Keyboard.Shortcut.Common.Remove}
                onAction={() => onPlanChange({ kind: "skip" })}
              />
            )}
            {!isSuggested && (
              <Action
                title={suggestion ? "自動の選択に戻す" : "未決定に戻す"}
                icon={Icon.Undo}
                shortcut={{ modifiers: ["cmd"], key: "z" }}
                onAction={() => onPlanChange(suggestion)}
              />
            )}
          </ActionPanel.Section>
          {commonActions}
        </ActionPanel>
      }
    />
  );
}
