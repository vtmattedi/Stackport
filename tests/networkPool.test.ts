import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = path.resolve(__dirname, "../stackport.sh").replace(/\\/g, "/");
const bash = (code: string, env: Record<string, string> = {}): { status: number | null; out: string } => {
  const run = spawnSync("bash", ["-c", code], { encoding: "utf8", env: { ...process.env, ETC_DIR: os.tmpdir().replace(/\\/g, "/"), VAR_DIR: os.tmpdir().replace(/\\/g, "/"), ...env } });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

/** A JSON tool for the merge: the script needs python3, python or jq. */
const hasJson = bash("for c in python3 python; do command -v $c >/dev/null && $c -c 'import json' 2>/dev/null && exit 0; done; command -v jq >/dev/null").status === 0;

interface Sandbox {
  json: string;
  calls: string;
  run(args: string, options?: { routes?: string; addrs?: string; breakOnPool?: boolean }): { status: number | null; out: string; systemctl: string[] };
}

/** The real network_pool_set, with docker, ip, systemctl and sleep replaced by stubs that read what the test sets. */
function sandbox(daemonJson: string | null): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stackport-pool-"));
  const json = path.join(dir, "docker", "daemon.json");
  fs.mkdirSync(path.dirname(json), { recursive: true });
  if (daemonJson !== null) fs.writeFileSync(json, daemonJson);
  const calls = path.join(dir, "calls");
  const toBash = (p: string): string => p.replace(/\\/g, "/");
  return {
    json,
    calls,
    run(args, options = {}) {
      const code = `
        source '${script}'
        docker() {
          case "$1" in
            info)
              if [[ -n "\${BREAK_ON_POOL:-}" ]] && grep -q 'default-address-pools' "$DAEMON_JSON" 2>/dev/null; then return 1; fi
              [[ "$*" == *DefaultAddressPools* ]] && printf '%s' "\${DOCKER_POOLS:-}"; return 0 ;;
            *) return 0 ;;
          esac
        }
        ip() { if [[ "$3" == route ]]; then printf '%s\\n' "\${HOST_ROUTES:-}"; else printf '%s\\n' "\${HOST_ADDRS:-}"; fi; }
        systemctl() { echo "systemctl $*" >> '${toBash(calls)}'; return 0; }
        sleep() { :; }
        network_pool set ${args}
      `;
      const result = bash(code, {
        DAEMON_JSON: toBash(json), HOST_ROUTES: options.routes ?? "", HOST_ADDRS: options.addrs ?? "", NETWORK_POOL_WAIT_S: "4",
        ...(options.breakOnPool ? { BREAK_ON_POOL: "1" } : {}),
      });
      return { ...result, systemctl: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [] };
    },
  };
}

// ---- the range arithmetic

test("cidr_range and cidr_overlaps", () => {
  const range = bash(`source '${script}'; cidr_range 10.20.0.0/14; cidr_range 192.168.1.5; cidr_range 10.20.0.1/14; cidr_range 300.1.1.1/8 || echo bad1; cidr_range 10.0.0.0/33 || echo bad2; cidr_range nope || echo bad3`).out.trim().split("\n");
  const start = (10 << 24 | 20 << 16) >>> 0;
  assert.equal(range[0], `${start} ${start + 2 ** 18 - 1}`);
  const host = ((192 << 24) | (168 << 16) | (1 << 8) | 5) >>> 0;
  assert.equal(range[1], `${host} ${host}`, "a bare address is a /32");
  assert.equal(range[2], range[0], "host bits are ignored by cidr_range itself");
  assert.deepEqual(range.slice(3), ["bad1", "bad2", "bad3"]);
  const overlaps = (a: string, b: string): boolean => bash(`source '${script}'; cidr_overlaps ${a} ${b}`).status === 0;
  assert.equal(overlaps("10.20.0.0/14", "10.21.5.0/24"), true);
  assert.equal(overlaps("10.20.0.0/14", "10.24.0.0/16"), false);
  assert.equal(overlaps("172.17.0.0/16", "172.16.0.0/12"), true);
  assert.equal(overlaps("10.20.0.0/14", "10.20.0.0/14"), true);
  assert.equal(overlaps("192.168.0.0/16", "10.0.0.0/8"), false);
});

// ---- what it refuses

test("it refuses a range that is not valid, has host bits, or is the wrong size, before touching anything", () => {
  for (const [args, reason] of [
    ["--base nonsense --size 24", /--base must be an IPv4 range/],
    ["--base 10.20.0.0 --size 24", /needs a prefix length/],
    ["--base 10.20.0.0/14 --size 14", /--size must be larger than the base/],
    ["--base 10.20.0.0/14 --size 29", /at most 28/],
    ["--base 10.20.0.0/14 --size x", /--size must be a prefix length/],
    ["--base 10.0.0.0/4 --size 24", /between \/8 and \/24/],
    ["--base 10.21.0.0/14 --size 24", /host bits set/],
    ["--surprise", /unknown option/],
  ] as const) {
    const s = sandbox('{ "keep": 1 }');
    const r = s.run(`${args} --no-restart`);
    assert.notEqual(r.status, 0, args);
    assert.match(r.out, reason, args);
    assert.equal(fs.readFileSync(s.json, "utf8"), '{ "keep": 1 }', `${args}: daemon.json untouched`);
  }
});

test("it refuses a range the host already uses (a VPN route, an interface), and ignores Docker's own bridges", { skip: !hasJson }, () => {
  const vpn = sandbox('{ "keep": 1 }').run("--base 10.20.0.0/14 --size 24 --no-restart", { routes: "10.22.0.0/16 dev tun0 scope link\n10.0.0.1 dev eth0" });
  assert.notEqual(vpn.status, 0);
  assert.match(vpn.out, /overlaps ranges this host already uses: 10\.22\.0\.0\/16/);
  const iface = sandbox(null).run("--base 10.20.0.0/14 --size 24 --no-restart", { addrs: "2: eth1    inet 10.21.0.5/24 brd 10.21.0.255 scope global eth1" });
  assert.match(iface.out, /10\.21\.0\.5\/24/);
  const own = sandbox(null).run("--base 172.16.0.0/12 --size 24 --no-restart", { routes: "172.17.0.0/16 dev docker0 proto kernel\n172.18.0.0/16 dev br-abc123 proto kernel\ndefault via 10.0.0.1 dev eth0", addrs: "3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\n1: lo    inet 127.0.0.1/8 scope host lo" });
  assert.equal(own.status, 0, own.out);
});

// ---- what it writes

test("it merges into an existing daemon.json, keeping every other key, and keeps a backup; without a restart Docker is left alone", { skip: !hasJson }, () => {
  const original = '{\n  "live-restore": true,\n  "log-driver": "json-file"\n}\n';
  const s = sandbox(original);
  const r = s.run("--base 10.20.0.0/14 --size 24 --no-restart");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.json, "utf8")), { "live-restore": true, "log-driver": "json-file", "default-address-pools": [{ base: "10.20.0.0/14", size: 24 }] });
  const backups = fs.readdirSync(path.dirname(s.json)).filter((n) => n.includes(".stackport-") && n.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(s.json), backups[0]), "utf8"), original);
  assert.deepEqual(r.systemctl, [], "Docker was not restarted");
  assert.match(r.out, /1024 networks/);
  assert.match(r.out, /sudo systemctl restart docker/);
});

test("with no daemon.json it creates one; an existing pool is replaced, not added to", { skip: !hasJson }, () => {
  const fresh = sandbox(null);
  assert.equal(fresh.run("--base 172.80.0.0/12 --size 24 --no-restart").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh.json, "utf8")), { "default-address-pools": [{ base: "172.80.0.0/12", size: 24 }] });
  const replaced = sandbox('{ "default-address-pools": [{ "base": "10.1.0.0/16", "size": 24 }] }');
  assert.equal(replaced.run("--base 10.20.0.0/14 --size 26 --no-restart").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(replaced.json, "utf8"))["default-address-pools"], [{ base: "10.20.0.0/14", size: 26 }]);
});

test("a daemon.json that is not valid JSON is not overwritten", { skip: !hasJson }, () => {
  const s = sandbox("{ this is not json");
  const r = s.run("--base 10.20.0.0/14 --size 24 --no-restart");
  assert.notEqual(r.status, 0);
  assert.match(r.out, /cannot change/);
  assert.equal(fs.readFileSync(s.json, "utf8"), "{ this is not json");
});

// ---- the restart

test("with --yes it restarts Docker once and reports the pool", { skip: !hasJson }, () => {
  const s = sandbox("{}");
  const r = s.run("--base 10.20.0.0/14 --size 24 --yes");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.systemctl, ["systemctl restart docker"]);
  assert.match(r.out, /Docker is back/);
});

test("if Docker does not come back, the previous daemon.json is restored and Docker is restarted with it", { skip: !hasJson }, () => {
  const original = '{ "log-driver": "json-file" }\n';
  const s = sandbox(original);
  const r = s.run("--base 10.20.0.0/14 --size 24 --yes", { breakOnPool: true });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Docker did not come back with the new pool/);
  assert.match(r.out, /restored the previous/);
  assert.equal(fs.readFileSync(s.json, "utf8"), original);
  assert.deepEqual(r.systemctl, ["systemctl restart docker", "systemctl restart docker"]);
});

test("with nothing to restore, a failed first attempt removes the file it created", { skip: !hasJson }, () => {
  const s = sandbox(null);
  const r = s.run("--base 10.20.0.0/14 --size 24 --yes", { breakOnPool: true });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(s.json), false);
});
