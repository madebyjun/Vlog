import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** 外部コマンドを実行して標準出力を返す (失敗時は reject) */
export function run(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
