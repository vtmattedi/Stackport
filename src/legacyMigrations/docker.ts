import { execFile } from "child_process";

/** TEMPORARY (see types.ts): runs the docker CLI for the migrations; injectable for tests. */
export interface DockerResult { code: number; stdout: string; stderr: string }
export type DockerRunner = (args: string[]) => Promise<DockerResult>;

export function dockerRunner(): DockerRunner {
  return (args) => new Promise((resolve) => {
    execFile("docker", args, { timeout: 3_600_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
