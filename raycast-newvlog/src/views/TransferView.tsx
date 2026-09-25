import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
  Keyboard,
} from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GroupProgress, RunState } from "../lib/engine";
import { formatDuration, formatGib, progressBar } from "../lib/format";
import { JobPaths, JobStatus, cancelJob, clearJob, readJob } from "../lib/job";

interface Props {
  paths: JobPaths;
  /** 結果を破棄して新しいスキャンへ戻る */
  onRestart: () => void;
}

const POLL_MS = 500;
const CRASHED_MESSAGE =
  "転送プロセスが途中で終了しました (強制終了・再起動など)。再実行すれば未転送のファイルだけ転送されます。";

/** バックグラウンドの転送ジョブの状態ファイルを定期的に読む */
function useJobStatus(paths: JobPaths): JobStatus | undefined {
  const [status, setStatus] = useState<JobStatus>();
  useEffect(() => {
    let active = true;
    let timer: NodeJS.Timeout | undefined;
    const poll = async () => {
      const next = await readJob(paths);
      if (!active) return;
      setStatus(next);
      // 終了後は状態が変わらないので読み直さない
      if (next.kind === "starting" || next.kind === "running") timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [paths]);
  return status;
}

/** 異常終了したジョブは「中断」として表示する */
function displayState(status: JobStatus): RunState | undefined {
  if (status.kind === "running" || status.kind === "finished") return status.state;
  if (status.kind === "crashed" && status.state) {
    return {
      ...status.state,
      phase: "aborted",
      fatalError: CRASHED_MESSAGE,
      finishedAt: status.state.finishedAt ?? Date.now(),
      groups: status.state.groups.map((g) =>
        g.status === "transferring" || g.status === "preparing"
          ? { ...g, status: "failed", currentFile: undefined }
          : g,
      ),
    };
  }
  return undefined;
}

function statusIcon(g: GroupProgress): List.Item.Props["icon"] {
  switch (g.status) {
    case "pending":
      return { source: Icon.Circle, tintColor: Color.SecondaryText };
    case "skipped":
      return { source: Icon.Forward, tintColor: Color.SecondaryText };
    case "preparing":
      return { source: Icon.Folder, tintColor: Color.Blue };
    case "ready":
      return { source: Icon.Clock, tintColor: Color.Blue };
    case "transferring": {
      const ratio = g.totalBytes > 0 ? (g.doneBytes + (g.currentFileBytes ?? 0)) / g.totalBytes : 0;
      const source =
        ratio < 0.25
          ? Icon.CircleProgress25
          : ratio < 0.5
            ? Icon.CircleProgress50
            : ratio < 0.75
              ? Icon.CircleProgress75
              : Icon.CircleProgress100;
      return { source, tintColor: Color.Blue };
    }
    case "done":
      return { source: Icon.CheckCircle, tintColor: Color.Green };
    case "partial":
      return { source: Icon.Warning, tintColor: Color.Orange };
    case "failed":
      return { source: Icon.XMarkCircle, tintColor: Color.Red };
  }
}

function statusLabel(status: GroupProgress["status"]): string {
  switch (status) {
    case "pending":
      return "待機中";
    case "skipped":
      return "スキップ";
    case "preparing":
      return "フォルダ準備中";
    case "ready":
      return "転送待ち";
    case "transferring":
      return "転送中";
    case "done":
      return "完了";
    case "partial":
      return "一部失敗";
    case "failed":
      return "中断";
  }
}

function phaseTitle(state: RunState): string {
  if (state.phase === "running") return state.currentDevice ? `🚚 転送中 — ${state.currentDevice}` : "🚚 転送中";
  if (state.phase === "aborted") return "🛑 中断しました";
  return state.failed.length > 0 ? "⚠️ 完了 (失敗あり)" : "🎉 全処理完了！";
}

export function TransferView({ paths, onRestart }: Props) {
  const status = useJobStatus(paths);
  if (!status || status.kind === "starting") {
    return <List isLoading navigationTitle="転送中..." searchBarPlaceholder="転送を準備しています..." />;
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

function TransferProgress({ paths, state, onRestart }: Props & { state: RunState }) {
  const { pop } = useNavigation();
  const [, setTick] = useState(0);
  const toastRef = useRef<Toast | null>(null);
  const lastToastKey = useRef("");

  // 経過時間表示のための1秒タイマー
  useEffect(() => {
    if (state.phase !== "running") return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  // Toast で全体進捗を表示 (変化があった時だけ更新)
  useEffect(() => {
    const key = `${state.phase}|${state.doneFiles}|${state.failed.length}|${state.currentDevice ?? ""}`;
    if (key === lastToastKey.current) return;
    lastToastKey.current = key;

    const update = async () => {
      if (state.phase === "running") {
        const title = `転送中 ${state.doneFiles}/${state.totalFiles} ファイル`;
        const message = `${formatGib(state.doneBytes)} / ${formatGib(state.totalBytes)}`;
        if (toastRef.current) {
          toastRef.current.title = title;
          toastRef.current.message = message;
        } else {
          toastRef.current = await showToast({ style: Toast.Style.Animated, title, message });
        }
        return;
      }
      const style = state.phase === "aborted" || state.failed.length > 0 ? Toast.Style.Failure : Toast.Style.Success;
      const title = phaseTitle(state);
      const message =
        state.phase === "aborted"
          ? state.fatalError
          : `${state.doneFiles}/${state.totalFiles} ファイル転送${state.failed.length > 0 ? ` / 失敗 ${state.failed.length}件` : ""}`;
      if (toastRef.current) {
        toastRef.current.style = style;
        toastRef.current.title = title;
        toastRef.current.message = message;
      } else {
        toastRef.current = await showToast({ style, title, message });
      }
    };
    void update();
  }, [state]);

  const elapsed = (state.finishedAt ?? Date.now()) - state.startedAt;
  const overallRatio =
    state.totalBytes > 0
      ? state.doneBytes / state.totalBytes
      : state.totalFiles > 0
        ? state.doneFiles / state.totalFiles
        : 0;
  const current = state.groups.find((g) => g.status === "transferring");

  const overallMarkdown = useMemo(() => {
    const lines: string[] = [`## ${phaseTitle(state)}`, "", "```", progressBar(overallRatio), "```", ""];
    lines.push(
      `**ファイル:** ${state.doneFiles} / ${state.totalFiles}   **サイズ:** ${formatGib(state.doneBytes)} / ${formatGib(state.totalBytes)}`,
    );
    lines.push("");
    if (current?.currentFile) {
      const size = current.currentFileSize ?? 0;
      const bytes = current.currentFileBytes ?? 0;
      lines.push(`**現在:** \`${current.currentFile}\`  (${formatGib(bytes)} / ${formatGib(size)})`);
      lines.push("");
    }
    if (state.phase === "running") {
      lines.push("> 💡 転送はバックグラウンドで続きます。Raycast を閉じても大丈夫です (完了すると通知が届きます)。");
      lines.push("");
    }
    if (state.fatalError) {
      lines.push(`> ❌ ${state.fatalError}`);
      lines.push("");
    }
    if (state.phase !== "running" && state.failed.length > 0) {
      lines.push(`### ⚠️ 転送に失敗したファイル (${state.failed.length}件)`);
      for (const entry of state.failed) lines.push(`- ${entry}`);
      lines.push("");
      lines.push("💡 これらは履歴に記録されていないため、原因を解消して再実行すれば失敗分だけ再転送されます。");
      lines.push("");
    }
    lines.push("### 📜 ログ");
    lines.push("```");
    lines.push(...state.log.slice(-40));
    lines.push("```");
    return lines.join("\n");
  }, [state, overallRatio, current]);

  const cancelTransfer = async () => {
    const ok = await confirmAlert({
      icon: { source: Icon.Stop, tintColor: Color.Red },
      title: "転送を中止しますか？",
      message: "転送中のファイルは停止され、履歴には記録されません (次回実行時に再転送されます)。",
      primaryAction: { title: "中止する", style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "続行" },
    });
    if (ok && !(await cancelJob(paths))) {
      await showToast({ style: Toast.Style.Failure, title: "転送プロセスが見つかりません" });
    }
  };

  const finishAndRestart = async () => {
    await clearJob(paths);
    toastRef.current?.hide();
    onRestart();
    pop();
  };

  const projectDirs = [...new Set(state.groups.map((g) => g.projectDir).filter((p): p is string => Boolean(p)))];

  const globalActions = (
    <ActionPanel.Section title="全体">
      {state.phase === "running" ? (
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
      {projectDirs.length > 0 && (
        <ActionPanel.Submenu title="プロジェクトフォルダを開く" icon={Icon.Finder}>
          {projectDirs.map((dir) => (
            <Action.ShowInFinder key={dir} title={dir.split("/").slice(-2).join("/")} path={dir} />
          ))}
        </ActionPanel.Submenu>
      )}
      <Action.CopyToClipboard
        title="ログをコピー"
        content={state.log.join("\n")}
        shortcut={Keyboard.Shortcut.Common.Copy}
      />
      {state.logFile && <Action.ShowInFinder title="ログファイルを表示" path={state.logFile} />}
    </ActionPanel.Section>
  );

  const devices = [...new Set(state.groups.map((g) => g.deviceName))];

  return (
    <List
      isShowingDetail
      isLoading={state.phase === "running"}
      navigationTitle={state.phase === "running" ? "転送中..." : "転送結果"}
      searchBarPlaceholder="日付で絞り込み"
    >
      <List.Section title="進捗">
        <List.Item
          title="全体"
          subtitle={`${state.doneFiles}/${state.totalFiles} ファイル`}
          icon={
            state.phase === "running"
              ? { source: Icon.Upload, tintColor: Color.Blue }
              : state.phase === "aborted"
                ? { source: Icon.XMarkCircle, tintColor: Color.Red }
                : state.failed.length > 0
                  ? { source: Icon.Warning, tintColor: Color.Orange }
                  : { source: Icon.CheckCircle, tintColor: Color.Green }
          }
          accessories={[
            { text: `${Math.round(overallRatio * 100)}%` },
            { text: formatDuration(elapsed), icon: Icon.Clock },
          ]}
          detail={<List.Item.Detail markdown={overallMarkdown} />}
          actions={<ActionPanel>{globalActions}</ActionPanel>}
        />
      </List.Section>

      {devices.map((device) => (
        <List.Section key={device} title={device}>
          {state.groups
            .filter((g) => g.deviceName === device)
            .map((g) => {
              const ratio = g.totalBytes > 0 ? (g.doneBytes + (g.currentFileBytes ?? 0)) / g.totalBytes : 0;
              const md: string[] = [
                `## 📅 ${g.date}  —  ${g.deviceName}`,
                "",
                `**状態:** ${statusLabel(g.status)}`,
                "",
                "```",
                progressBar(ratio),
                "```",
                "",
                `**ファイル:** ${g.doneFiles} / ${g.totalFiles}${g.failedFiles > 0 ? ` (失敗 ${g.failedFiles})` : ""}   **サイズ:** ${formatGib(g.doneBytes)} / ${formatGib(g.totalBytes)}`,
                "",
              ];
              if (g.currentFile) {
                md.push(
                  `**現在:** \`${g.currentFile}\`  (${formatGib(g.currentFileBytes ?? 0)} / ${formatGib(g.currentFileSize ?? 0)})`,
                  "",
                );
              }
              if (g.failedNames.length > 0) {
                md.push("### ⚠️ 失敗したファイル", ...g.failedNames.map((n) => `- ${n}`), "");
              }
              return (
                <List.Item
                  key={g.id}
                  title={g.date}
                  subtitle={statusLabel(g.status)}
                  icon={statusIcon(g)}
                  accessories={[{ text: `${g.doneFiles}/${g.totalFiles}` }]}
                  detail={
                    <List.Item.Detail
                      markdown={md.join("\n")}
                      metadata={
                        <List.Item.Detail.Metadata>
                          <List.Item.Detail.Metadata.Label title="状態" text={statusLabel(g.status)} />
                          {g.projectDir && <List.Item.Detail.Metadata.Label title="プロジェクト" text={g.projectDir} />}
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
            })}
        </List.Section>
      ))}
    </List>
  );
}
