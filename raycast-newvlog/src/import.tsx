import { List } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { readJob } from "./lib/job";
import { raycastJobPaths } from "./lib/runtime";
import { ScanView } from "./views/ScanView";
import { TransferView } from "./views/TransferView";

type Mode = "loading" | "scan" | "transfer";

export default function Command() {
  const paths = useMemo(() => raycastJobPaths(), []);
  // バックグラウンドで転送中 (または結果未確認) のジョブがあれば、その進捗画面を表示する
  const [mode, setMode] = useState<Mode>("loading");

  useEffect(() => {
    void readJob(paths).then((status) => setMode(status.kind === "none" ? "scan" : "transfer"));
  }, [paths]);

  if (mode === "loading") return <List isLoading navigationTitle="Import Vlog Footage" />;
  // 転送開始後はプラン画面の上に重ねず、ルートごと切り替える (Esc で古いプランに戻れないように)
  if (mode === "transfer") return <TransferView paths={paths} onRestart={() => setMode("scan")} />;
  return <ScanView onStarted={() => setMode("transfer")} />;
}
