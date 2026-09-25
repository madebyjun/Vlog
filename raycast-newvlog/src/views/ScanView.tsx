import { Action, ActionPanel, Color, Icon, Keyboard, List, launchCommand, LaunchType, popToRoot } from "@raycast/api";
import path from "node:path";
import { ReactNode, useCallback, useEffect, useState } from "react";
import { loadRaycastSettings } from "../lib/runtime";
import { DateGroup, DetectedDevice, detectDevices, scanDevice } from "../lib/scan";
import { Settings, SettingsErrors } from "../lib/settings";
import { SsdContext, getFreeBytes, prepareSsd } from "../lib/ssd";
import { PlanView } from "./PlanView";
import { SettingsForm } from "./SettingsForm";

export interface ScanData {
  settings: Settings;
  ctx: SsdContext;
  devices: DetectedDevice[];
  groups: DateGroup[];
  freeBytes: number;
}

type ScanState =
  | { status: "loading" }
  | { status: "setup" }
  | { status: "invalid"; errors: SettingsErrors }
  | { status: "error"; message: string }
  | { status: "ready"; data: ScanData };

/** スクリプトの 1. SSD準備 & 2. デバイス検出・ファイルスキャン に相当 */
async function performScan(settings: Settings): Promise<ScanData> {
  const ctx = await prepareSsd(settings.ssdUuid);
  const devices = await detectDevices(ctx.mount);
  const groups: DateGroup[] = [];
  for (const device of devices) {
    groups.push(...(await scanDevice(device, ctx, settings)));
  }
  const freeBytes = await getFreeBytes(ctx.mount);
  return { settings, ctx, devices, groups, freeBytes };
}

export function ScanView({ onStarted }: { onStarted: () => void }) {
  const [state, setState] = useState<ScanState>({ status: "loading" });

  const rescan = useCallback(async () => {
    setState({ status: "loading" });
    const loaded = loadRaycastSettings();
    if (loaded.kind === "missing") {
      setState({ status: "setup" });
      return;
    }
    if (loaded.kind === "invalid") {
      setState({ status: "invalid", errors: loaded.errors });
      return;
    }
    try {
      setState({ status: "ready", data: await performScan(loaded.settings) });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  if (state.status === "setup") {
    return <SettingsForm onboarding onSaved={() => void rescan()} />;
  }
  if (state.status === "ready" && state.data.groups.length > 0) {
    return <PlanView data={state.data} onRescan={() => void rescan()} onStarted={onStarted} />;
  }

  const actions = (primary?: ReactNode) => (
    <ActionPanel>
      {primary}
      <Action
        title="再スキャン"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => void rescan()}
      />
      <Action.Push
        title="設定"
        icon={Icon.Gear}
        shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
        target={
          <SettingsForm
            onSaved={() => {
              void popToRoot();
              void rescan();
            }}
          />
        }
      />
      <Action
        title="取り込み履歴"
        icon={Icon.Clock}
        shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
        onAction={() => void launchCommand({ name: "import-history", type: LaunchType.UserInitiated })}
      />
    </ActionPanel>
  );

  let empty: ReactNode = null;
  if (state.status === "invalid") {
    empty = (
      <List.EmptyView
        icon={{ source: Icon.Warning, tintColor: Color.Orange }}
        title="設定に問題があります"
        description={Object.values(state.errors).join("\n")}
        actions={actions()}
      />
    );
  } else if (state.status === "error") {
    empty = (
      <List.EmptyView
        icon={{ source: Icon.HardDrive, tintColor: Color.Red }}
        title={state.message}
        description="SSD が接続されているか、設定の保存先SSDが正しいか確認してください。"
        actions={actions()}
      />
    );
  } else if (state.status === "ready" && state.data.devices.length === 0) {
    empty = (
      <List.EmptyView
        icon={Icon.Camera}
        title="撮影デバイスが接続されていません"
        description={`Osmo Action または DJI Mic を接続して ⌘R で再スキャンしてください。\n保存先: ${path.basename(state.data.ctx.mount)}`}
        actions={actions()}
      />
    );
  } else if (state.status === "ready") {
    empty = (
      <List.EmptyView
        icon={{ source: Icon.CheckCircle, tintColor: Color.Green }}
        title="新しいファイルはありません"
        description={`${state.data.devices.map((d) => d.name).join("、")} のファイルはすべて取り込み済みです。`}
        actions={actions()}
      />
    );
  }

  return (
    <List isLoading={state.status === "loading"} navigationTitle="Import Vlog Footage">
      {empty ?? <List.EmptyView icon={Icon.MagnifyingGlass} title="SSDとデバイスを確認しています…" />}
    </List>
  );
}
