import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  showToast,
} from "@raycast/api";
import { getProgressIcon } from "@raycast/utils";
import path from "node:path";
import { ReactNode, useEffect, useState } from "react";
import type { GroupProgress, RunState } from "../lib/engine";
import { formatDuration, formatEta, formatGib, formatPercent, formatSize, formatSpeed } from "../lib/format";
import { JobPaths, cancelJob, clearJob } from "../lib/job";
import { progressStats } from "../lib/progress";
import { refreshMenuBar } from "../lib/runtime";
import {
  CRASHED_MESSAGE,
  OUTCOME,
  displayState,
  groupIcon,
  groupLabel,
  groupRatio,
  outcomeOf,
  projectDirsOf,
  useJobStatus,
} from "./status";

interface Props {
  paths: JobPaths;
  /** 結果を片付けて新しいスキャンへ戻る */
  onRestart: () => void;
}

export function TransferView({ paths, onRestart }: Props) {
  const status = useJobStatus(paths);
  if (!status || status.kind === "starting") {
    return <List isLoading navigationTitle="転送を準備しています" />;
  }
  const state = displayState(status);
  if (!state) {
    return (
      <List navigationTitle="転送結果">
        <List.EmptyView
          icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
          title="転送の状態を読み込めませんでした"
          description={status.kind === "crashed" ? CRASHED_MESSAGE : undefined}
          actions={
            <ActionPanel>
              <Action
                title="新しいスキャンを開始"
                icon={Icon.ArrowClockwise}
                onAction={() => void clearJob(paths).then(onRestart)}
              />
            </ActionPanel>
          }
        />
      </List>
    );
  }
  return <TransferProgress paths={paths} state={state} onRestart={onRestart} />;
}

/** 経過時間・残り時間の表示を 1 秒ごとに進める */
function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function TransferProgress({ paths, state, onRestart }: Props & { state: RunState }) {
  const running = state.phase === "running";
  const now = useNow(running);
  const stats = progressStats(state, now);
  const outcome = outcomeOf(state);
  const current = state.groups.find((g) => g.status === "transferring" && g.currentFile);
  const projectDirs = projectDirsOf(state);

  const cancelTransfer = async () => {
    const ok = await confirmAlert({
      icon: { source: Icon.Stop, tintColor: Color.Red },
      title: "転送を中止しますか？",
      message: "転送中のファイルは停止され、履歴には記録されません (次回実行時に再転送されます)。",
      primaryAction: { title: "中止する", style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "続ける" },
    });
    if (!ok) return;
    if (await cancelJob(paths)) {
      await showToast({ style: Toast.Style.Animated, title: "中止しています…" });
    } else {
      await showToast({ style: Toast.Style.Failure, title: "転送プロセスが見つかりません" });
    }
  };

  const finishAndRestart = async () => {
    if (!(await clearJob(paths))) {
      await showToast({ style: Toast.Style.Failure, title: "転送がまだ実行中です" });
      return;
    }
    await refreshMenuBar();
    onRestart();
  };

  const globalActions = (
    <>
      <ActionPanel.Section>
        {running ? (
          <Action
            title="転送を中止"
            icon={Icon.Stop}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["cmd", "shift"], key: "." }}
            onAction={() => void cancelTransfer()}
          />
        ) : (
          <Action
            title="新しいスキャンを開始"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={() => void finishAndRestart()}
          />
        )}
        <Action.Push
          title="ログを表示"
          icon={Icon.Terminal}
          shortcut={{ modifiers: ["cmd"], key: "l" }}
          target={<LogView paths={paths} />}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        {projectDirs.length === 1 && (
          <Action.ShowInFinder
            title="プロジェクトフォルダを開く"
            path={projectDirs[0]}
            shortcut={Keyboard.Shortcut.Common.Open}
          />
        )}
        {projectDirs.length > 1 && (
          <ActionPanel.Submenu
            title="プロジェクトフォルダを開く"
            icon={Icon.Finder}
            shortcut={Keyboard.Shortcut.Common.Open}
          >
            {projectDirs.map((dir) => (
              <Action.ShowInFinder key={dir} title={path.basename(dir)} path={dir} />
            ))}
          </ActionPanel.Submenu>
        )}
        {state.logFile && <Action.ShowInFinder title="ログファイルを表示" path={state.logFile} />}
        <Action.CopyToClipboard
          title="ログをコピー"
          content={state.log.join("\n")}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
      </ActionPanel.Section>
    </>
  );

  const failureMarkdown = [
    state.fatalError ? `**${state.fatalError}**\n` : "",
    !running && state.failed.length > 0
      ? [
          `### 転送できなかったファイル (${state.failed.length})`,
          ...state.failed.map((f) => `- ${f}`),
          "",
          "これらは履歴に記録されていないので、原因を解消して再実行すると失敗分だけ再転送されます。",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const overallTitle = running
    ? state.currentDevice
      ? `転送中 — ${state.currentDevice}`
      : "転送中"
    : outcome === "success"
      ? "転送完了"
      : outcome === "partial"
        ? "完了 (一部失敗)"
        : "中断しました";

  const devices = [...new Set(state.groups.map((g) => g.deviceName))];

  return (
    <List
      isShowingDetail
      navigationTitle={running ? "転送中" : "転送結果"}
      searchBarPlaceholder="日付・デバイスで絞り込み"
    >
      <List.Section title="全体">
        <List.Item
          title={overallTitle}
          icon={
            running
              ? getProgressIcon(stats.ratio, Color.Blue)
              : { source: OUTCOME[outcome].icon, tintColor: OUTCOME[outcome].color }
          }
          accessories={
            running
              ? [
                  { text: formatPercent(stats.ratio) },
                  ...(stats.etaMs !== undefined ? [{ text: formatEta(stats.etaMs) }] : []),
                ]
              : [{ text: formatDuration(stats.elapsedMs), icon: Icon.Clock }]
          }
          detail={
            <List.Item.Detail
              markdown={failureMarkdown || undefined}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.TagList title="状態">
                    <List.Item.Detail.Metadata.TagList.Item
                      text={OUTCOME[outcome].label}
                      color={OUTCOME[outcome].color}
                    />
                  </List.Item.Detail.Metadata.TagList>
                  <List.Item.Detail.Metadata.Label
                    title="進捗"
                    text={formatPercent(stats.ratio)}
                    icon={getProgressIcon(stats.ratio, OUTCOME[outcome].color)}
                  />
                  <List.Item.Detail.Metadata.Label title="ファイル" text={`${state.doneFiles} / ${state.totalFiles}`} />
                  <List.Item.Detail.Metadata.Label
                    title="サイズ"
                    text={`${formatGib(stats.processedBytes)} / ${formatGib(stats.totalBytes)}`}
                  />
                  {stats.bytesPerSec !== undefined && (
                    <List.Item.Detail.Metadata.Label
                      title={running ? "速度" : "平均速度"}
                      text={formatSpeed(stats.bytesPerSec)}
                    />
                  )}
                  {stats.etaMs !== undefined && (
                    <List.Item.Detail.Metadata.Label title="残り時間" text={formatEta(stats.etaMs)} />
                  )}
                  <List.Item.Detail.Metadata.Label title="経過時間" text={formatDuration(stats.elapsedMs)} />
                  {current?.currentFile && (
                    <>
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="転送中のファイル" text={current.currentFile} />
                      <List.Item.Detail.Metadata.Label
                        title=""
                        text={`${formatSize(current.currentFileBytes ?? 0)} / ${formatSize(current.currentFileSize ?? 0)}`}
                      />
                    </>
                  )}
                  {state.failed.length > 0 && (
                    <>
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label
                        title="失敗"
                        text={`${state.failed.length} ファイル`}
                        icon={{ source: Icon.Warning, tintColor: Color.Orange }}
                      />
                    </>
                  )}
                  {running && (
                    <>
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label
                        title=""
                        text="Raycast を閉じても転送は続きます"
                        icon={Icon.Info}
                      />
                    </>
                  )}
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={<ActionPanel>{globalActions}</ActionPanel>}
        />
      </List.Section>

      {devices.map((device) => (
        <List.Section key={device} title={device}>
          {state.groups
            .filter((g) => g.deviceName === device)
            .map((g) => (
              <GroupItem key={g.id} group={g} globalActions={globalActions} />
            ))}
        </List.Section>
      ))}
    </List>
  );
}

function GroupItem({ group: g, globalActions }: { group: GroupProgress; globalActions: ReactNode }) {
  const ratio = groupRatio(g);
  return (
    <List.Item
      title={g.date}
      subtitle={groupLabel(g.status)}
      keywords={[g.deviceName]}
      icon={groupIcon(g)}
      accessories={
        g.status === "skipped"
          ? []
          : [
              ...(g.failedFiles > 0 ? [{ tag: { value: `失敗 ${g.failedFiles}`, color: Color.Orange } }] : []),
              { text: `${g.doneFiles}/${g.totalFiles}` },
            ]
      }
      detail={
        <List.Item.Detail
          markdown={
            g.failedNames.length > 0
              ? [`### 転送できなかったファイル (${g.failedNames.length})`, ...g.failedNames.map((n) => `- ${n}`)].join(
                  "\n",
                )
              : undefined
          }
          metadata={
            <List.Item.Detail.Metadata>
              <List.Item.Detail.Metadata.Label title="状態" text={groupLabel(g.status)} icon={groupIcon(g)} />
              {g.status !== "skipped" && (
                <>
                  <List.Item.Detail.Metadata.Label title="進捗" text={formatPercent(ratio)} />
                  <List.Item.Detail.Metadata.Label title="ファイル" text={`${g.doneFiles} / ${g.totalFiles}`} />
                  <List.Item.Detail.Metadata.Label
                    title="サイズ"
                    text={`${formatGib(g.doneBytes + (g.currentFileBytes ?? 0))} / ${formatGib(g.totalBytes)}`}
                  />
                </>
              )}
              {g.currentFile && <List.Item.Detail.Metadata.Label title="転送中のファイル" text={g.currentFile} />}
              <List.Item.Detail.Metadata.Separator />
              <List.Item.Detail.Metadata.Label title="デバイス" text={g.deviceName} />
              {g.projectDir && (
                <List.Item.Detail.Metadata.Label title="プロジェクト" text={path.basename(g.projectDir)} />
              )}
              {g.destDir && <List.Item.Detail.Metadata.Label title="転送先" text={g.destDir} />}
            </List.Item.Detail.Metadata>
          }
        />
      }
      actions={
        <ActionPanel>
          {g.projectDir && (
            <ActionPanel.Section title={g.date}>
              <Action.ShowInFinder title="プロジェクトフォルダを開く" path={g.projectDir} />
              {g.destDir && <Action.ShowInFinder title="転送先フォルダを開く" path={g.destDir} />}
            </ActionPanel.Section>
          )}
          {globalActions}
        </ActionPanel>
      }
    />
  );
}

/** ログ全文。転送中は追従して更新する */
function LogView({ paths }: { paths: JobPaths }) {
  const status = useJobStatus(paths, 1000);
  const state = status ? displayState(status) : undefined;
  const log = state?.log ?? [];
  return (
    <Detail
      isLoading={!status || state?.phase === "running"}
      navigationTitle="転送ログ"
      markdown={["```", ...log.slice(-300), "```"].join("\n")}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="ログをコピー" content={log.join("\n")} />
          {state?.logFile && <Action.Open title="ログファイルを開く" target={state.logFile} />}
        </ActionPanel>
      }
    />
  );
}
