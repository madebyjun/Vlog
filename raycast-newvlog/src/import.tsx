import { List } from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { readJob } from "./lib/job";
import { raycastJobPaths } from "./lib/runtime";
import { ScanView } from "./views/ScanView";
import { TransferView } from "./views/TransferView";

export default function Command() {
  const paths = useMemo(() => raycastJobPaths(), []);
  // バックグラウンドで転送中 (または結果未確認) のジョブがあれば、その進捗画面を表示する
  const [hasJob, setHasJob] = useState<boolean>();

  useEffect(() => {
    void readJob(paths).then((status) => setHasJob(status.kind !== "none"));
  }, [paths]);

  if (hasJob === undefined) return <List isLoading navigationTitle="New Vlog Import" />;
  if (hasJob) {
    return <TransferView paths={paths} onRestart={() => setHasJob(false)} />;
  }
  return <ScanView />;
}
