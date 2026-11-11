import cp from "child_process";

/**
 * A stand-in for the `docker` and `openssl` commands, so pages that read Docker, Nginx and Certbot show something in the screenshot
 * harness: a few Compose stacks, a running Nginx container, certificates that are valid, expiring, expired and missing. It replaces
 * `child_process.execFile` inside the harness process only, before the app is imported. Commands it does not know answer "not found",
 * except `network` and `info`, which go to the real Docker if there is one (the Networks page is built from them).
 *
 * UI_HARNESS_DOCKER=real turns it off and shows whatever the machine's own Docker has.
 */

type Callback = (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void;
interface Answer { out?: string; err?: string; fail?: boolean }

const DAY = 24 * 60 * 60 * 1000;
const label = (project: string, service: string): string => `com.docker.compose.project=${project},com.docker.compose.service=${service}`;

interface FakeContainer { id: string; name: string; image: string; state: "running" | "exited"; status: string; ports: string; project: string | null; service: string; cpu: string; mem: string; memPct: string }

const CONTAINERS: FakeContainer[] = [
  { id: "a1b2c3d4e5f6", name: "stackport", image: "stackport:1.3.10", state: "running", status: "Up 3 days (healthy)", ports: "127.0.0.1:3000->3000/tcp", project: "stackport", service: "stackport", cpu: "0.4%", mem: "182MiB / 3.8GiB", memPct: "4.6%" },
  { id: "b2c3d4e5f6a1", name: "stackport-nginx", image: "nginx:1.27-alpine", state: "running", status: "Up 3 days", ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp", project: "stackport", service: "nginx", cpu: "0.1%", mem: "12MiB / 3.8GiB", memPct: "0.3%" },
  { id: "c3d4e5f6a1b2", name: "shop-web-1", image: "shop-web", state: "running", status: "Up 2 days (healthy)", ports: "127.0.0.1:8101->3000/tcp", project: "shop", service: "web", cpu: "1.2%", mem: "96MiB / 3.8GiB", memPct: "2.4%" },
  { id: "d4e5f6a1b2c3", name: "shop-db-1", image: "postgres:17-alpine", state: "running", status: "Up 2 days (healthy)", ports: "", project: "shop", service: "db", cpu: "0.3%", mem: "64MiB / 3.8GiB", memPct: "1.6%" },
  { id: "e5f6a1b2c3d4", name: "shop-api-api-1", image: "shop-api", state: "running", status: "Up 2 days", ports: "127.0.0.1:8102->8080/tcp", project: "shop-api", service: "api", cpu: "0.8%", mem: "120MiB / 3.8GiB", memPct: "3.1%" },
  { id: "f6a1b2c3d4e5", name: "shop-staging-web-1", image: "shop-web", state: "exited", status: "Exited (0) 4 days ago", ports: "", project: "shop-staging", service: "web", cpu: "--", mem: "--", memPct: "--" },
  { id: "0a1b2c3d4e5f", name: "blog-blog-1", image: "ghost:5-alpine", state: "running", status: "Up 6 hours", ports: "127.0.0.1:8103->2368/tcp", project: "blog", service: "blog", cpu: "0.2%", mem: "210MiB / 3.8GiB", memPct: "5.4%" },
  { id: "1b2c3d4e5f6a", name: "watchtower", image: "containrrr/watchtower", state: "running", status: "Up 9 days", ports: "", project: null, service: "", cpu: "0.0%", mem: "8MiB / 3.8GiB", memPct: "0.2%" },
];

const STACKS = [
  { Name: "stackport", Status: "running(2)", ConfigFiles: "/opt/stackport/docker-compose.yml" },
  { Name: "shop", Status: "running(2)", ConfigFiles: "/srv/stackport/repos/shop/docker-compose.yml" },
  { Name: "shop-api", Status: "running(1)", ConfigFiles: "/srv/stackport/repos/shop-api/docker-compose.yml" },
  { Name: "shop-staging", Status: "exited(1)", ConfigFiles: "/srv/stackport/repos/shop-staging/docker-compose.yml" },
  { Name: "blog", Status: "running(1)", ConfigFiles: "/srv/stackport/repos/blog/docker-compose.yml" },
];

/** days until expiry per hostname the harness seeds; absent means no certificate yet. */
const CERT_DAYS: Record<string, number> = { "shop.example.com": 61, "shop-api.example.com": 12, "shop-staging.example.com": -3 };

const ndjson = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

function answer(cmd: string, args: string[]): Answer | null {
  if (cmd === "openssl") {
    const file = args[args.indexOf("-in") + 1] ?? "";
    const domain = /live\/([^/]+)\//.exec(file.replace(/\\/g, "/"))?.[1] ?? "";
    const days = CERT_DAYS[domain];
    if (days === undefined) return { fail: true };
    if (args.includes("-enddate")) return { out: `notAfter=${new Date(Date.now() + days * DAY).toUTCString().replace("GMT", "GMT")}\n` };
    if (args.includes("-issuer")) return { out: "issuer=C = US, O = Let's Encrypt, CN = R11\n" };
    return { fail: true };
  }
  if (cmd !== "docker") return null;

  const [a, b] = args;
  if (a === "version") return { out: JSON.stringify({ Client: { Version: "27.3.1" }, Server: { Version: "27.3.1" } }) };
  if (a === "ps") {
    return {
      out: ndjson(CONTAINERS.map((c) => ({ ID: c.id, Names: c.name, Image: c.image, State: c.state, Status: c.status, Ports: c.ports, Labels: c.project ? label(c.project, c.service) : "" }))),
    };
  }
  if (a === "stats") {
    return { out: ndjson(CONTAINERS.filter((c) => c.state === "running").map((c) => ({ ID: c.id, CPUPerc: c.cpu, MemUsage: c.mem, MemPerc: c.memPct, NetIO: "1.2MB / 800kB", BlockIO: "0B / 0B" }))) };
  }
  if (a === "compose" && b === "ls") return { out: JSON.stringify(STACKS) };
  if (a === "system" && b === "df") {
    return {
      out: ndjson([
        { Type: "Images", TotalCount: "34", Active: "9", Size: "11.2GB", Reclaimable: "6.4GB (57%)" },
        { Type: "Containers", TotalCount: "8", Active: "7", Size: "46MB", Reclaimable: "0B (0%)" },
        { Type: "Local Volumes", TotalCount: "9", Active: "6", Size: "2.1GB", Reclaimable: "310MB (14%)" },
        { Type: "Build Cache", TotalCount: "212", Active: "0", Size: "3.4GB", Reclaimable: "3.4GB" },
      ]),
    };
  }
  if (a === "inspect" && args.includes("stackport-nginx")) return { out: "true\n" };
  if (a === "exec" && args[1] === "stackport-nginx") {
    const rest = args.slice(2);
    if (rest[0] === "nginx" && rest[1] === "-v") return { err: "nginx version: nginx/1.27.2\n" };
    if (rest[0] === "nginx" && rest[1] === "-t") return { err: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n" };
    if (rest[0] === "test") {
      const domain = /live\/([^/]+)\//.exec((rest[2] ?? "").replace(/\\/g, "/"))?.[1] ?? "";
      return CERT_DAYS[domain] === undefined ? { fail: true } : { out: "" };
    }
    return { out: "" };
  }
  if (a === "run" && args.includes("certbot/certbot") && args.includes("--version")) return { out: "certbot 3.0.1\n" };
  if (a === "info" && args.join(" ").includes("DockerRootDir")) return { out: JSON.stringify("/var/lib/docker") };
  if (a === "network" || a === "info") return null; // the real Docker, when there is one
  return { fail: true };
}

export function installFakeDocker(): void {
  if (process.env["UI_HARNESS_DOCKER"] === "real") return;
  const real = cp.execFile;
  const patched = ((cmd: string, ...rest: unknown[]): unknown => {
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const callback = rest.find((item): item is Callback => typeof item === "function");
    const fake = callback ? answer(cmd, args) : null;
    if (!fake || !callback) return (real as unknown as (...a: unknown[]) => unknown)(cmd, ...rest);
    setImmediate(() => {
      if (fake.fail) callback(Object.assign(new Error("exit status 1"), { code: 1 }), "", fake.err ?? "");
      else callback(null, fake.out ?? "", fake.err ?? "");
    });
    return { kill: () => true, on: () => undefined, stdout: null, stderr: null };
  }) as unknown as typeof cp.execFile;
  cp.execFile = patched;
}
