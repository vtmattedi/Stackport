import { execFile } from "child_process";
import { pollingCadenceS } from "../../config/pollingCadence";
import { SingleFlightCache } from "../../utils/singleFlightCache";
import { getNginxRuntime } from "./configWriter";

export interface RunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  notFound: boolean;
}

function run(cmd: string, args: string[], timeoutMs = 12_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const notFound = !!(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ stdout, stderr, ok: !err, notFound });
    });
  });
}

const nginxVersionCache = new SingleFlightCache<RunResult>(
  () => run("nginx", ["-v"]),
  null, // startup / explicit refresh only
);
const nginxActiveStatusCache = new SingleFlightCache<RunResult>(
  () => run("systemctl", ["is-active", "nginx"]),
  pollingCadenceS.nginxActiveStatus * 1000,
);

const containerVersionCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["exec", "stackport-nginx", "nginx", "-v"]),
  pollingCadenceS.nginxActiveStatus * 1000,
);
const containerActiveCache = new SingleFlightCache<RunResult>(
  () => run("docker", ["inspect", "--format", "{{.State.Running}}", "stackport-nginx"]),
  pollingCadenceS.nginxActiveStatus * 1000,
);

export const getNginxVersionCached = (): Promise<RunResult> =>
  (getNginxRuntime() === "container" ? containerVersionCache : nginxVersionCache).get();
export const getNginxActiveStatusCached = (): Promise<RunResult> =>
  (getNginxRuntime() === "container" ? containerActiveCache : nginxActiveStatusCache).get();

/** Called right after installing nginx from the System page. */
export function invalidateNginxVersion(): void {
  nginxVersionCache.invalidate();
  containerVersionCache.invalidate();
}

/** Called after every real config apply (writeNginxConfig) — a reload can flip
 *  active/inactive either way. `nginx -t` itself is never re-run here; config
 *  validity is read from the persisted result of that same apply instead. */
export function invalidateNginxActiveStatus(): void {
  nginxActiveStatusCache.invalidate();
  containerActiveCache.invalidate();
}
