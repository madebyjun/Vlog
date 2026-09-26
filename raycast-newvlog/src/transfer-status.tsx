import {
  Color,
  Icon,
  Keyboard,
  LaunchType,
  MenuBarExtra,
  Toast,
  launchCommand,
  open,
  showHUD,
  showInFinder,
  showToast,
} from "@raycast/api";
import { getProgressIcon, usePromise } from "@raycast/utils";
import path from "node:path";
import { formatEta, formatGib, formatPercent, formatSpeed } from "./lib/format";
import { readHistory } from "./lib/history";
import { cancelJob, clearJob, readJob } from "./lib/job";
import { progressStats } from "./lib/progress";
import { logDirPath, raycastJobPaths } from "./lib/runtime";
import { OUTCOME, displayState, groupIcon, groupLabel, outcomeOf, projectDirsOf } from "./views/status";

// メニューバーの転送状況。転送中は進捗、終了後は結果、何もしていないときは前回の取り込みを表示する。
// Raycast が一定間隔 (package.json の interval) と、メニューを開いたときに再実行する。

async function openImport() {
  await launchCommand({ name: "import", type: LaunchType.UserInitiated });
}

async function openHistory() {
  await launchCommand({ name: "import-history", type: LaunchType.UserInitiated });
}

async function openSettings() {
  await launchCommand({ name: "configure", type: LaunchType.UserInitiated });
}

/** 転送していないとき: 前回の取り込みと、各コマンドへの入り口 */
function IdleMenu() {
  const { data: history, isLoading } = usePromise(() => readHistory(logDirPath()));
  const last = history?.[0];
  const lastRun = last?.kind === "run" ? last.summary : undefined;
  const lastOutcome = lastRun ? outcomeOf(lastRun) : undefined;
  const lastProjects = lastRun ? projectDirsOf(lastRun) : [];

  return (
    <MenuBarExtra icon={Icon.Video} tooltip="Vlog Import: 転送していません" isLoading={isLoading}>
      <MenuBarExtra.Section title="転送していません">
        <MenuBarExtra.Item
          title="素材を取り込む…"
          icon={Icon.Download}
          shortcut={Keyboard.Shortcut.Common.Open}
          onAction={openImport}
        />
      </MenuBarExtra.Section>
      {last && (
        <MenuBarExtra.Section title="前回の取り込み">
          <MenuBarExtra.Item
            title={lastProjects.length > 0 ? lastProjects.map((p) => path.basename(p)).join(", ") : "詳細なし"}
            subtitle={`${new Date(last.startedAt).toLocaleDateString("ja-JP")}${lastOutcome ? ` · ${OUTCOME[lastOutcome].label}` : ""}`}
            icon={
              lastOutcome ? { source: OUTCOME[lastOutcome].icon, tintColor: OUTCOME[lastOutcome].color } : Icon.Document
            }
            tooltip={lastRun ? `${lastRun.doneFiles} ファイル · ${formatGib(lastRun.doneBytes)}` : undefined}
            onAction={lastProjects.length === 1 ? () => void open(lastProjects[0]) : openHistory}
          />
        </MenuBarExtra.Section>
      )}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="取り込み履歴" icon={Icon.Clock} onAction={openHistory} />
        <MenuBarExtra.Item title="設定…" icon={Icon.Gear} onAction={openSettings} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}

export default function Command() {
  const paths = raycastJobPaths();
  const { data: status, isLoading, revalidate } = usePromise(() => readJob(paths));

  if (isLoading && !status) return <MenuBarExtra isLoading />;
  if (!status || status.kind === "none") return <IdleMenu />;

  if (status.kind === "starting") {
    return (
      <MenuBarExtra icon={getProgressIcon(0, Color.Blue)} tooltip="転送を準備しています">
        <MenuBarExtra.Item title="転送を準備しています…" />
        <MenuBarExtra.Item title="進捗を開く" icon={Icon.AppWindow} onAction={openImport} />
      </MenuBarExtra>
    );
  }

  const state = displayState(status);
  if (!state) {
    return (
      <MenuBarExtra icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }} tooltip="転送が中断しました">
        <MenuBarExtra.Item title="転送の状態を読み込めませんでした" />
        <MenuBarExtra.Item title="Raycast で開く" icon={Icon.AppWindow} onAction={openImport} />
      </MenuBarExtra>
    );
  }

  const running = state.phase === "running";
  const stats = progressStats(state);
  const outcome = outcomeOf(state);
  const current = state.groups.find((g) => g.status === "transferring" && g.currentFile);
  const projectDirs = projectDirsOf(state);

  const icon = running
    ? getProgressIcon(stats.ratio, Color.Blue, { background: Color.SecondaryText })
    : { source: OUTCOME[outcome].icon, tintColor: OUTCOME[outcome].color };
  const tooltip = running ? `Vlog 転送中 ${formatPercent(stats.ratio)}` : `Vlog 転送: ${OUTCOME[outcome].label}`;

  return (
    <MenuBarExtra icon={icon} title={running ? formatPercent(stats.ratio) : undefined} tooltip={tooltip}>
      <MenuBarExtra.Section
        title={running ? `転送中${state.currentDevice ? ` — ${state.currentDevice}` : ""}` : OUTCOME[outcome].label}
      >
        <MenuBarExtra.Item
          title={`${state.doneFiles} / ${state.totalFiles} ファイル`}
          subtitle={`${formatGib(stats.processedBytes)} / ${formatGib(stats.totalBytes)}`}
          icon={Icon.Document}
        />
        {stats.bytesPerSec !== undefined && (
          <MenuBarExtra.Item
            title={running ? formatSpeed(stats.bytesPerSec) : `平均 ${formatSpeed(stats.bytesPerSec)}`}
            subtitle={stats.etaMs !== undefined ? formatEta(stats.etaMs) : undefined}
            icon={Icon.Gauge}
          />
        )}
        {current?.currentFile && <MenuBarExtra.Item title={current.currentFile} icon={Icon.ArrowRight} />}
        {state.failed.length > 0 && (
          <MenuBarExtra.Item
            title={`${state.failed.length} ファイルが失敗`}
            icon={{ source: Icon.Warning, tintColor: Color.Orange }}
            onAction={openImport}
          />
        )}
        {state.fatalError && (
          <MenuBarExtra.Item title={state.fatalError} icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }} />
        )}
      </MenuBarExtra.Section>

      <MenuBarExtra.Section title="日付">
        {state.groups
          .filter((g) => g.status !== "skipped")
          .map((g) => (
            <MenuBarExtra.Item
              key={g.id}
              title={`${g.date}  ${g.deviceName}`}
              subtitle={g.status === "transferring" ? `${g.doneFiles}/${g.totalFiles}` : groupLabel(g.status)}
              icon={groupIcon(g)}
              tooltip={g.projectDir ? path.basename(g.projectDir) : undefined}
              onAction={g.projectDir ? () => void showInFinder(g.projectDir as string) : undefined}
            />
          ))}
      </MenuBarExtra.Section>

      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title={running ? "進捗を開く" : "結果を開く"}
          icon={Icon.AppWindow}
          shortcut={Keyboard.Shortcut.Common.Open}
          onAction={openImport}
        />
        {!running && projectDirs.length === 1 && (
          <MenuBarExtra.Item
            title="プロジェクトフォルダを開く"
            icon={Icon.Finder}
            onAction={() => void open(projectDirs[0])}
          />
        )}
        {!running && projectDirs.length > 1 && (
          <MenuBarExtra.Submenu title="プロジェクトフォルダを開く" icon={Icon.Finder}>
            {projectDirs.map((dir) => (
              <MenuBarExtra.Item key={dir} title={path.basename(dir)} onAction={() => void open(dir)} />
            ))}
          </MenuBarExtra.Submenu>
        )}
        {state.logFile && (
          <MenuBarExtra.Item
            title="ログファイルを開く"
            icon={Icon.Terminal}
            onAction={() => void open(state.logFile as string)}
          />
        )}
        {running ? (
          <MenuBarExtra.Item
            title="転送を中止"
            icon={Icon.Stop}
            onAction={async () => {
              if (await cancelJob(paths)) {
                revalidate();
                await showHUD("転送を中止しています");
              } else await showToast({ style: Toast.Style.Failure, title: "転送プロセスが見つかりません" });
            }}
          />
        ) : (
          <MenuBarExtra.Item
            title="結果を閉じる"
            subtitle="待機表示に戻ります"
            icon={Icon.XMarkCircle}
            onAction={async () => {
              if (await clearJob(paths)) {
                revalidate();
                await showHUD("転送結果を閉じました");
              }
            }}
          />
        )}
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
