import { Action, ActionPanel, Color, Icon, Keyboard, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import path from "node:path";
import type { RunSummary } from "./lib/engine";
import { formatDuration, formatGib, formatSpeed } from "./lib/format";
import { HistoryEntry, readHistory } from "./lib/history";
import { progressStats } from "./lib/progress";
import { logDirPath } from "./lib/runtime";
import { OUTCOME, groupIcon, groupLabel, outcomeOf, projectDirsOf } from "./views/status";

function monthTitle(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function formatDateTime(time: number): string {
  return new Date(time).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Command() {
  const { data: entries = [], isLoading, revalidate } = usePromise(() => readHistory(logDirPath()));

  const sections = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const key = monthTitle(entry.startedAt);
    sections.set(key, [...(sections.get(key) ?? []), entry]);
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={entries.length > 0}
      searchBarPlaceholder="プロジェクト名・撮影日で検索"
    >
      <List.EmptyView
        icon={Icon.Clock}
        title="まだ取り込みの履歴がありません"
        description="Import Vlog Footage で転送すると、ここに記録されます。"
      />
      {[...sections].map(([title, items]) => (
        <List.Section key={title} title={title}>
          {items.map((entry) =>
            entry.kind === "run" ? (
              <RunItem key={entry.id} entry={entry} summary={entry.summary} onRefresh={revalidate} />
            ) : (
              <List.Item
                key={entry.id}
                title="詳細なし (古い形式のログ)"
                icon={{ source: Icon.Document, tintColor: Color.SecondaryText }}
                accessories={[{ date: new Date(entry.startedAt) }]}
                detail={
                  <List.Item.Detail
                    metadata={
                      <List.Item.Detail.Metadata>
                        <List.Item.Detail.Metadata.Label title="開始" text={formatDateTime(entry.startedAt)} />
                        <List.Item.Detail.Metadata.Label title="ログ" text={path.basename(entry.logFile)} />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.Open title="ログを開く" target={entry.logFile} icon={Icon.Terminal} />
                    <Action.ShowInFinder path={entry.logFile} />
                  </ActionPanel>
                }
              />
            ),
          )}
        </List.Section>
      ))}
    </List>
  );
}

function RunItem({
  entry,
  summary,
  onRefresh,
}: {
  entry: Extract<HistoryEntry, { kind: "run" }>;
  summary: RunSummary;
  onRefresh: () => void;
}) {
  const outcome = outcomeOf(summary);
  const stats = progressStats({ ...summary, log: [] });
  const projects = projectDirsOf(summary);
  const shotDates = [...new Set(summary.groups.filter((g) => g.status !== "skipped").map((g) => g.date))].sort();
  const title = projects.length > 0 ? projects.map((p) => path.basename(p)).join(", ") : "転送なし";

  return (
    <List.Item
      title={title}
      icon={{ source: OUTCOME[outcome].icon, tintColor: OUTCOME[outcome].color }}
      keywords={[...shotDates, ...summary.groups.map((g) => g.deviceName)]}
      accessories={[{ date: new Date(summary.startedAt), tooltip: formatDateTime(summary.startedAt) }]}
      detail={
        <List.Item.Detail
          markdown={
            summary.failed.length > 0 || summary.fatalError
              ? [
                  summary.fatalError ? `**${summary.fatalError}**\n` : "",
                  summary.failed.length > 0 ? `### 転送できなかったファイル (${summary.failed.length})` : "",
                  ...summary.failed.map((f) => `- ${f}`),
                ].join("\n")
              : undefined
          }
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.TagList title="結果">
                <List.Item.Detail.Metadata.TagList.Item text={OUTCOME[outcome].label} color={OUTCOME[outcome].color} />
              </List.Item.Detail.Metadata.TagList>
              <List.Item.Detail.Metadata.Label title="開始" text={formatDateTime(summary.startedAt)} />
              <List.Item.Detail.Metadata.Label title="所要時間" text={formatDuration(stats.elapsedMs)} />
              <List.Item.Detail.Metadata.Label title="ファイル" text={`${summary.doneFiles} / ${summary.totalFiles}`} />
              <List.Item.Detail.Metadata.Label title="サイズ" text={formatGib(summary.doneBytes)} />
              {stats.bytesPerSec !== undefined && (
                <List.Item.Detail.Metadata.Label title="平均速度" text={formatSpeed(stats.bytesPerSec)} />
              )}
              <List.Item.Detail.Metadata.Label title="保存先SSD" text={path.basename(summary.ssdMount)} />
              <List.Item.Detail.Metadata.Separator />
              {summary.groups.map((g) => (
                <List.Item.Detail.Metadata.Label
                  key={g.id}
                  title={`${g.date}  ${g.deviceName}`}
                  text={g.projectDir ? `${path.basename(g.projectDir)} · ${g.doneFiles}ファイル` : groupLabel(g.status)}
                  icon={groupIcon(g)}
                />
              ))}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {projects.length === 1 && <Action.ShowInFinder title="プロジェクトフォルダを開く" path={projects[0]} />}
          {projects.length > 1 && (
            <ActionPanel.Submenu title="プロジェクトフォルダを開く" icon={Icon.Finder}>
              {projects.map((dir) => (
                <Action.ShowInFinder key={dir} title={path.basename(dir)} path={dir} />
              ))}
            </ActionPanel.Submenu>
          )}
          {entry.logFile && (
            <Action.Open
              title="ログを開く"
              target={entry.logFile}
              icon={Icon.Terminal}
              shortcut={{ modifiers: ["cmd"], key: "l" }}
            />
          )}
          {entry.logFile && <Action.ShowInFinder title="ログファイルを表示" path={entry.logFile} />}
          <Action
            title="再読み込み"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={onRefresh}
          />
        </ActionPanel>
      }
    />
  );
}
