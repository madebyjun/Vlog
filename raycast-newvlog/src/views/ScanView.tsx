import { Action, ActionPanel, Detail, Icon, List, openExtensionPreferences } from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { DateGroup, DetectedDevice, detectDevices, scanDevice } from "../lib/scan";
import { Settings, loadSettings } from "../lib/settings";
import { SsdContext, getFreeBytes, prepareSsd } from "../lib/ssd";
import { PlanView } from "./PlanView";

export interface ScanData {
  settings: Settings;
  ctx: SsdContext;
  devices: DetectedDevice[];
  groups: DateGroup[];
  freeBytes: number;
}

type ScanState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ScanData };

/** スクリプトの 1. SSD準備 & 2. デバイス検出・ファイルスキャン に相当 */
async function performScan(): Promise<ScanData> {
  const settings = loadSettings();
  const ctx = await prepareSsd(settings.ssdUuid);
  const devices = await detectDevices(ctx.mount);
  const groups: DateGroup[] = [];
  for (const device of devices) {
    groups.push(...(await scanDevice(device, ctx, settings)));
  }
  const freeBytes = await getFreeBytes(ctx.mount);
  return { settings, ctx, devices, groups, freeBytes };
}

export function ScanView() {
  const [state, setState] = useState<ScanState>({ status: "loading" });

  const rescan = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await performScan();
      setState({ status: "ready", data });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  if (state.status === "loading") {
    return (
      <List isLoading navigationTitle="New Vlog Import">
        <List.EmptyView icon={Icon.MagnifyingGlass} title="🔍 SSDとデバイスを確認しています..." />
      </List>
    );
  }

  if (state.status === "error") {
    return (
      <Detail
        navigationTitle="New Vlog Import"
        markdown={`# ❌ エラー\n\n${state.message}\n\n---\n\nSSD の接続と、拡張機能の設定 (SSD UUID) を確認してから「再スキャン」を実行してください。`}
        actions={
          <ActionPanel>
            <Action title="再スキャン" icon={Icon.ArrowClockwise} onAction={() => void rescan()} />
            <Action title="拡張機能の設定を開く" icon={Icon.Gear} onAction={() => void openExtensionPreferences()} />
          </ActionPanel>
        }
      />
    );
  }

  const { data } = state;
  const header = `✅ SSD準備完了 (履歴: ${data.ctx.historyCount}件)\n\n- マウント: \`${data.ctx.mount}\`\n- 保存先: \`${data.ctx.footageRoot}\``;

  if (data.devices.length === 0) {
    return (
      <Detail
        navigationTitle="New Vlog Import"
        markdown={`${header}\n\n# 💤 接続されたデバイスが見つかりません。\n\nOsmo Action / DJI Mic を接続してから「再スキャン」を実行してください。`}
        actions={
          <ActionPanel>
            <Action title="再スキャン" icon={Icon.ArrowClockwise} onAction={() => void rescan()} />
          </ActionPanel>
        }
      />
    );
  }

  if (data.groups.length === 0) {
    const deviceList = data.devices.map((d) => `- ✅ ${d.name} (\`${d.sourceDir}\`)`).join("\n");
    return (
      <Detail
        navigationTitle="New Vlog Import"
        markdown={`${header}\n\n## 🔎 検出されたデバイス\n\n${deviceList}\n\n# 🎉 新しいファイルはありません。`}
        actions={
          <ActionPanel>
            <Action title="再スキャン" icon={Icon.ArrowClockwise} onAction={() => void rescan()} />
          </ActionPanel>
        }
      />
    );
  }

  return <PlanView data={data} onRescan={() => void rescan()} />;
}
