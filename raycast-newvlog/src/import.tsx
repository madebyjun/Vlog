import { useState } from "react";
import { getCurrentRun } from "./lib/engine";
import { ScanView } from "./views/ScanView";
import { TransferView } from "./views/TransferView";

export default function Command() {
  // 転送中(または結果未確認)の実行があれば、その進捗画面に再接続する
  const [run, setRun] = useState(() => getCurrentRun());

  if (run) {
    return <TransferView run={run} onRestart={() => setRun(null)} />;
  }
  return <ScanView />;
}
