/* eslint-disable security/detect-object-injection -- keys come from a fixed list of Compose fields, or are our own network name. */
import * as fs from "fs";
import * as path from "path";
import { splitPortSpec } from "./yaml";
import { relativeInside } from "../../../shared/hostPath";
import { resolveContainedPath } from "../../../shared/safePath";
import { INGRESS_NETWORK, ingressAlias, isReservedIngressServiceName } from "../../../shared/ingressNames";

/** StackPort's security/exposure boundary for managed-project compose files: the
 *  Phase 1.3 directives that let a container escape into host/StackPort authority
 *  (SP_dockerization.md §6), plus the Phase 1.7 hard cutover — `ports:` (any
 *  host-port publication) is rejected outright, never silently rewritten. Routing is
 *  domain -> service -> container_port instead (project_domains.service/
 *  container_port, composeNetworking.ts's stackport-proxy network attachment) —
 *  services declare `expose:` if anything, not `ports:`. */

const DANGEROUS_HOST_ROOTS = ["/etc", "/proc", "/sys", "/run", "/var/run"];
const DANGEROUS_CAPS = new Set(["ALL", "SYS_ADMIN"]);

function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith(".");
}

function isDangerousHostPath(hostPath: string): boolean {
  if (!isPathLike(hostPath)) return false; // a named volume reference, not a bind mount
  const normalized = path.posix.normalize(hostPath);
  if (normalized === "/") return true;
  if (normalized.toLowerCase().includes("docker.sock")) return true;
  return DANGEROUS_HOST_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function shortFormVolumeHostPath(entry: string): string | null {
  const parts = splitPortSpec(entry);
  if (parts.length < 2) return null; // a bare container-path entry, e.g. "/data" — no host side at all
  return parts[0];
}

function longFormVolumeHostPath(entry: Record<string, unknown>): string | null {
  const source = entry["source"];
  return typeof source === "string" ? source : null;
}

/** One rule a service breaks, with what to change. `key` is the Compose key under
 *  the service (`ports`, `volumes`, ...). */
export interface PolicyViolation {
  /** Top-level section the entry sits in; absent means `services`. */
  section?: "volumes" | "secrets" | "configs" | "networks" | "include";
  /** The service, or the entry name when `section` is set. */
  service: string;
  key: string;
  problem: string;
  fix: string;
}

/** The single-line form used in deploy logs. */
export function formatPolicyViolation(v: PolicyViolation): string {
  return `${v.section ?? "services"}.${v.service}.${v.key}: ${v.problem} ${v.fix}`;
}

function checkService(name: string, service: Record<string, unknown>, violations: PolicyViolation[]): void {
  const add = (key: string, problem: string, fix: string): number => violations.push({ service: name, key, problem, fix });

  const privileged = service["privileged"];
  if (privileged === true || privileged === "true") {
    add("privileged", "privileged containers are not allowed for managed projects.", 'Remove "privileged: true".');
  }

  for (const [field, label] of [["network_mode", "network_mode: host"], ["pid", "pid: host"], ["ipc", "ipc: host"]] as const) {
    if (service[field] === "host") {
      add(field, `"${label}" is not allowed for managed projects.`, `Remove "${field}: host"; services reach each other by name on the project network.`);
    }
  }

  const capAdd = service["cap_add"];
  if (Array.isArray(capAdd)) {
    for (const cap of capAdd) {
      if (typeof cap === "string" && DANGEROUS_CAPS.has(cap.toUpperCase())) {
        add("cap_add", `capability "${cap}" is not allowed for managed projects.`, `Remove "${cap}" and add only the specific capabilities the service needs.`);
      }
    }
  }

  const devices = service["devices"];
  if (Array.isArray(devices) && devices.length > 0) {
    add("devices", "device access is not allowed for managed projects.", 'Remove "devices:".');
  }

  const ports = service["ports"];
  if (Array.isArray(ports) && ports.length > 0) {
    add(
      "ports",
      "host port publication is not allowed for managed projects.",
      `Use "expose:" for the container port instead, then route a domain to the service ` +
      `(or add a TCP port) in the project's Domains tab.`,
    );
  }

  const volumes = service["volumes"];
  if (Array.isArray(volumes)) {
    for (const entry of volumes) {
      const hostPath = typeof entry === "string"
        ? shortFormVolumeHostPath(entry)
        : entry && typeof entry === "object"
          ? longFormVolumeHostPath(entry as Record<string, unknown>)
          : null;
      if (hostPath && isDangerousHostPath(hostPath)) {
        add("volumes", `mounting host path "${hostPath}" is not allowed for managed projects.`, "Use a named volume or a path inside the project folder.");
      }
    }
  }
}

/** Walks a parsed compose doc's services and returns every policy violation found,
 *  service-qualified and actionable. `ok: true` (empty violations) means the file may
 *  proceed to `up`. Never mutates the input — a violation is reported and the deploy
 *  is rejected, never silently stripped/rewritten (SP_dockerization.md §6, §14). */
export function validateComposePolicy(doc: unknown): { ok: boolean; violations: PolicyViolation[] } {
  const violations: PolicyViolation[] = [];
  if (!doc || typeof doc !== "object") return { ok: true, violations };
  const services = (doc as Record<string, unknown>)["services"];
  if (!services || typeof services !== "object") return { ok: true, violations };

  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    if (!service || typeof service !== "object") continue;
    checkService(name, service as Record<string, unknown>, violations);
  }

  return { ok: violations.length === 0, violations };
}

/** Where the project's files live; bind mounts must stay inside it. */
export interface ResolvedPolicyContext {
  projectDir: string;
  /** Lets the ingress alias rules name the project (sp<id>-<service>). */
  projectId?: number;
}

/** Whether `target` is inside the project folder, following symlinks when the folder is on
 *  this machine (S12): a link committed to the repository can point outside it, and the
 *  resolved path then looks inside while the host path is not. */
function isInsideProject(target: string, projectDir: string): boolean {
  const relative = relativeInside(target, projectDir);
  if (relative === null) return false;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths are inside a project's checkout: its directory plus a Compose file name picked from the files found there; any path a project supplies goes through resolveContainedPath first.
  if (path.isAbsolute(projectDir) && fs.existsSync(projectDir)) return resolveContainedPath(projectDir, relative) !== null;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

type Add = (service: string, key: string, problem: string, fix: string, section?: PolicyViolation["section"]) => void;

/** Bind mounts must stay inside the project folder (a, S1). Named volumes and tmpfs
 *  are fine; any other mount type is not on the allowlist. */
function checkResolvedVolumes(name: string, service: Record<string, unknown>, context: ResolvedPolicyContext, add: Add): void {
  const volumes = service["volumes"];
  if (!Array.isArray(volumes)) return;
  for (const entry of volumes) {
    const mount = asRecord(entry);
    if (!mount) continue;
    const type = mount["type"];
    if (type === "volume" || type === "tmpfs") continue;
    const source = typeof mount["source"] === "string" ? mount["source"] : "";
    if (type !== "bind") {
      add(name, "volumes", `mount type "${String(type)}" is not allowed for managed projects.`, "Use a named volume or a path inside the project folder.");
    } else if (!isInsideProject(source, context.projectDir) && !isDangerousHostPath(source)) { // the denylist already reports those
      add(name, "volumes", `mounting host path "${source}" is not allowed for managed projects: it is outside the project folder.`, "Use a named volume or a path inside the project folder.");
    }
  }
}

/** A service may share another service of the same project (`service:name`), never a
 *  container outside it: `container:stackport` would join Stackport's own network,
 *  PID or volumes, and with them the Docker socket and its secrets (h, S1). */
function checkResolvedSharing(name: string, service: Record<string, unknown>, serviceNames: Set<string>, add: Add): void {
  const sameProject = (value: string): boolean => value.startsWith("service:") && serviceNames.has(value.slice("service:".length));
  const fields: [string, readonly string[]][] = [
    ["network_mode", ["", "bridge", "default", "none", "host"]],
    ["pid", ["", "host"]],
    ["ipc", ["", "private", "shareable", "none", "host"]],
  ];
  for (const [field, plain] of fields) {
    const value = service[field];
    // "host" is already reported by the denylist.
    if (typeof value === "string" && !plain.includes(value) && !sameProject(value)) {
      add(name, field, `"${field}: ${value}" is not allowed for managed projects.`, `Use "service:<name>" for a service in this project, or remove "${field}".`);
    }
  }
  const volumesFrom = service["volumes_from"];
  if (Array.isArray(volumesFrom)) {
    for (const entry of volumesFrom) {
      if (typeof entry !== "string") continue;
      const source = entry.split(":")[0];
      if (source === "container" || !serviceNames.has(source)) {
        add(name, "volumes_from", `"volumes_from: ${entry}" is not allowed for managed projects.`, "Name a service in this project, not a container.");
      }
    }
  }
}

/** A path on the host, as opposed to a URL, `service:name` or `docker-image://` reference. */
function isLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** The build context, and any additional contexts, must be inside the project folder:
 *  a build can read every file in its context and copy it into the image (f, S1). A
 *  remote (git or http) context is not a host path and is left alone. */
function checkResolvedBuild(name: string, service: Record<string, unknown>, context: ResolvedPolicyContext, add: Add): void {
  const build = asRecord(service["build"]);
  if (!build) return;
  const contexts: [string, string][] = [];
  if (typeof build["context"] === "string") contexts.push(["build.context", build["context"]]);
  for (const [alias, value] of Object.entries(asRecord(build["additional_contexts"]) ?? {})) {
    if (typeof value === "string") contexts.push([`build.additional_contexts.${alias}`, value]);
  }
  for (const [label, value] of contexts) {
    if (isLocalPath(value) && !isInsideProject(value, context.projectDir)) {
      add(name, "build", `${label} "${value}" is outside the project folder.`, "Use a context inside the project folder, such as \".\".");
    }
  }
}

/** A secret or config backed by a file reads that file into the container, so the file
 *  must be inside the project folder (g, S1). `environment:`, `content:` and external
 *  entries do not read the host and are left alone. */
function checkTopLevelFiles(section: "secrets" | "configs", entries: Record<string, unknown> | null, context: ResolvedPolicyContext, add: Add): void {
  for (const [name, value] of Object.entries(entries ?? {})) {
    const file = asRecord(value)?.["file"];
    if (typeof file === "string" && !isInsideProject(file, context.projectDir)) {
      add(name, "file", `${section.slice(0, -1)} file "${file}" is outside the project folder.`, "Keep the file inside the project folder, or use environment: or content: instead.", section);
    }
  }
}

/** Capabilities a service may add. These are the ones ordinary servers need; each of
 *  the rest (SYS_PTRACE, SYS_MODULE, SYS_RAWIO, DAC_READ_SEARCH, BPF, ...) lets a
 *  container read or change what belongs to the host (e, S1). */
const ALLOWED_CAPS = new Set([
  "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP",
  "NET_BIND_SERVICE", "NET_RAW", "NET_ADMIN", "SYS_CHROOT", "MKNOD", "AUDIT_WRITE", "SETFCAP",
]);

/** Only `no-new-privileges` may be set; seccomp, AppArmor and SELinux options can switch
 *  the confinement off. */
const ALLOWED_SECURITY_OPT = /^no-new-privileges([:=]true)?$/i;

/** Capabilities, security options and namespace sharing (e, S1). */
function checkResolvedHardening(name: string, service: Record<string, unknown>, add: Add): void {
  const capAdd = service["cap_add"];
  if (Array.isArray(capAdd)) {
    for (const cap of capAdd) {
      if (typeof cap !== "string") continue;
      const normalized = cap.toUpperCase().replace(/^CAP_/, "");
      // ALL and SYS_ADMIN are already reported by the denylist.
      if (!ALLOWED_CAPS.has(normalized) && !DANGEROUS_CAPS.has(normalized)) {
        add(name, "cap_add", `capability "${cap}" is not allowed for managed projects.`, `Remove "${cap}"; only ${[...ALLOWED_CAPS].join(", ")} can be added.`);
      }
    }
  }
  const securityOpt = service["security_opt"];
  if (Array.isArray(securityOpt)) {
    for (const option of securityOpt) {
      if (typeof option === "string" && !ALLOWED_SECURITY_OPT.test(option)) {
        add(name, "security_opt", `security option "${option}" is not allowed for managed projects.`, 'Remove it; only "no-new-privileges" can be set.');
      }
    }
  }
  if (typeof service["userns_mode"] === "string" && service["userns_mode"] !== "") {
    add(name, "userns_mode", `"userns_mode: ${service["userns_mode"]}" is not allowed for managed projects.`, 'Remove "userns_mode".');
  }
  for (const field of ["uts", "cgroup"] as const) {
    if (service[field] === "host") {
      add(name, field, `"${field}: host" is not allowed for managed projects.`, `Remove "${field}: host".`);
    }
  }
}

/** A named volume is only a Docker-managed directory unless its driver says otherwise:
 *  the `local` driver can bind any host path (`type: none, o: bind, device: /`) and a
 *  plugin driver is code Stackport has not reviewed. Only plain `local` volumes, and
 *  local ones backed by a network or tmpfs filesystem, are allowed (c, S1). */
function checkTopLevelVolumes(volumes: Record<string, unknown> | null, project: string | null, add: Add): void {
  for (const [name, value] of Object.entries(volumes ?? {})) {
    const volume = asRecord(value);
    if (!volume) continue;
    const resolvedName = typeof volume["name"] === "string" ? volume["name"] : name;
    // A volume belongs to one project. An external one, or one given another project's name, attaches to
    // data this project does not own: Compose reuses a volume that already exists under that name.
    if (volume["external"] === true || volume["external"] === "true") {
      add(name, "external", `the volume "${resolvedName}" is external, so it is not this project's data.`, "Declare the volume without external: true so the project gets its own.", "volumes");
    } else if (project !== null && !resolvedName.startsWith(`${project}_`)) {
      add(name, "name", `the volume name "${resolvedName}" is not this project's (it would attach to an existing volume of that name).`, "Remove the name: line so Compose names the volume after the project.", "volumes");
    }
    const fix = "Remove driver and driver_opts, or use a plain named volume.";
    const driver = volume["driver"];
    if (typeof driver === "string" && driver !== "local") {
      add(name, "driver", `volume driver "${driver}" is not allowed for managed projects.`, fix, "volumes");
    }
    const opts = asRecord(volume["driver_opts"]);
    if (!opts) continue;
    const type = String(opts["type"] ?? "").toLowerCase();
    const options = String(opts["o"] ?? "").toLowerCase().split(",").map((o) => o.trim());
    if (type === "none" || type === "bind" || options.includes("bind") || options.includes("rbind")) {
      add(name, "driver_opts", "this volume bind-mounts a host path, which is not allowed for managed projects.", fix, "volumes");
    }
  }
}

/** Networks. A service can join an existing Docker network by naming it, including Stackport's
 *  own (`stackport_default`, where the admin API listens) or another project's. Only the shared
 *  ingress network may be external, and a network that is created must carry the project's name
 *  and use the bridge driver (other drivers reach the host's network). */
function checkTopLevelNetworks(networks: Record<string, unknown> | null, project: string | null, ingress: string, add: Add): void {
  for (const [key, value] of Object.entries(networks ?? {})) {
    const network = asRecord(value);
    if (!network) continue;
    const name = typeof network["name"] === "string" ? network["name"] : key;
    if (network["external"] === true || network["external"] === "true") {
      if (name !== ingress) {
        add(key, "external", `joining the existing network "${name}" is not allowed for managed projects.`, "Remove the external network; services reach each other on the project's own network, and Stackport attaches the ingress network itself.", "networks");
      }
      continue;
    }
    if (project !== null && !name.startsWith(`${project}_`)) {
      add(key, "name", `the network name "${name}" is not this project's (it would attach to an existing network of that name).`, "Remove the name: line so Compose names the network after the project.", "networks");
    }
    const driver = network["driver"];
    if (typeof driver === "string" && driver !== "bridge") {
      add(key, "driver", `network driver "${driver}" is not allowed for managed projects.`, "Use the default bridge driver.", "networks");
    }
  }
}

/** A service on the shared ingress network is visible to nginx by its own name and by its aliases. If it
 *  could choose either, it could answer for another project's service (`sp3-web`) or for Stackport's admin
 *  route (`stackport`). Stackport sets the alias; nothing else is accepted. */
function checkIngressAttachment(name: string, service: Record<string, unknown>, projectId: number, ingress: string, add: Add): void {
  const networks = asRecord(service["networks"]);
  const attached = networks?.[ingress];
  if (attached === undefined) return;
  if (isReservedIngressServiceName(name)) {
    add(name, "networks", `the service name "${name}" is reserved on the ingress network (nginx would take it for Stackport or another project).`, "Rename the service.", "networks");
  }
  const aliases = asRecord(attached)?.["aliases"];
  const extra = (Array.isArray(aliases) ? aliases : []).filter((a) => a !== ingressAlias(projectId, name));
  if (extra.length) {
    add(name, "networks", `aliases ${extra.map(String).join(", ")} on the ingress network are not allowed.`, "Remove the aliases; Stackport sets the alias nginx uses.", "networks");
  }
}

/** Checks the output of `docker compose config --format json`: variables resolved,
 *  `include:` and `extends:` merged, so a value the raw YAML only spelled indirectly
 *  (`${PRIV:-true}`, an included file) is seen as Compose will run it. Anything the
 *  rules below do not allow is a violation (S1). The raw-YAML check above stays in
 *  place as the first line of defence. */
export function validateResolvedComposePolicy(resolved: unknown, context: ResolvedPolicyContext): { ok: boolean; violations: PolicyViolation[] } {
  // Resolved values take the same denylist checks as the raw file; the allowlist rules
  // below close what a denylist cannot.
  const violations = [...validateComposePolicy(resolved).violations];
  const add: Add = (service, key, problem, fix, section) => { violations.push({ ...(section ? { section } : {}), service, key, problem, fix }); };
  const services = asRecord(asRecord(resolved)?.["services"]);
  const serviceNames = new Set(Object.keys(services ?? {}));
  for (const [name, value] of Object.entries(services ?? {})) {
    const service = asRecord(value);
    if (!service) continue;
    checkResolvedVolumes(name, service, context, add);
    checkResolvedHardening(name, service, add);
    checkResolvedBuild(name, service, context, add);
    checkResolvedSharing(name, service, serviceNames, add);
  }
  const projectName = typeof asRecord(resolved)?.["name"] === "string" ? (asRecord(resolved)!["name"] as string) : null;
  checkTopLevelVolumes(asRecord(asRecord(resolved)?.["volumes"]), projectName, add);
  checkTopLevelNetworks(asRecord(asRecord(resolved)?.["networks"]), projectName, INGRESS_NETWORK, add);
  for (const [name, value] of Object.entries(services ?? {})) {
    const service = asRecord(value);
    if (service && context.projectId !== undefined) checkIngressAttachment(name, service, context.projectId, INGRESS_NETWORK, add);
  }
  checkTopLevelFiles("secrets", asRecord(asRecord(resolved)?.["secrets"]), context, add);
  checkTopLevelFiles("configs", asRecord(asRecord(resolved)?.["configs"]), context, add);
  // The denylist already flags dangerous host paths; keep one violation per mount.
  const seen = new Set<string>();
  const unique = violations.filter((v) => {
    const key = `${v.service}|${v.key}|${v.problem}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { ok: unique.length === 0, violations: unique };
}

/** What `docker compose config` produced: the resolved document, or why there is none. */
export type ComposeResolution = { ok: true; doc: unknown } | { ok: false; reason: string };

/** The message deploy logs and the UI show for a rejected file. */
export function formatPolicyRejection(violations: PolicyViolation[]): string {
  return `Deployment rejected — compose policy violation:\n\n${violations.map(formatPolicyViolation).join("\n")}\n`;
}

export interface PolicyOutcome { ok: boolean; message: string; warning?: string }

/** Decides what to do with the resolved config (S1). A project that enforces the policy is
 *  refused when the config can't be resolved as well as when it breaks a rule: a file that
 *  cannot be checked is not allowed to run, whatever the reason (a timeout or a config too
 *  large for the buffer would otherwise let anything through). A project that predates the
 *  policy only gets a warning. */
export function evaluateResolvedPolicy(resolution: ComposeResolution, options: { enforced: boolean; projectDir: string; projectId?: number }): PolicyOutcome {
  if (!resolution.ok) {
    if (options.enforced) {
      return { ok: false, message: `Deployment refused: the Compose configuration could not be resolved, so it cannot be checked against the policy (${resolution.reason}). Fix the file or its env files and deploy again.\n` };
    }
    return { ok: true, message: "", warning: `Warning — the Compose configuration could not be resolved (${resolution.reason}), so the compose policy was not checked for this project.\n` };
  }
  const result = validateResolvedComposePolicy(resolution.doc, { projectDir: options.projectDir, projectId: options.projectId });
  if (result.ok) return { ok: true, message: "" };
  if (options.enforced) return { ok: false, message: formatPolicyRejection(result.violations) };
  return {
    ok: true,
    message: "",
    warning: formatPolicyRejection(result.violations).replace(
      "Deployment rejected — compose policy violation:",
      "Warning — this project predates the compose policy, so the deploy continues, but a new project would be rejected for:",
    ),
  };
}

/** A file Compose reads from the filesystem it runs on, which is the Stackport container's
 *  own: `env_file: /app/.env` would copy the app's secrets into a service's environment, and
 *  `include`, `extends` and a Dockerfile read files the same way. Each must stay inside the
 *  project folder. Only the raw YAML still has these paths: the resolved config inlines env
 *  files, so this check cannot be done there. */
export interface FileReference {
  kind: "env_file" | "extends" | "dockerfile" | "include" | "include-env_file";
  path: string;
  /** The service the reference belongs to; absent for a top-level `include`. */
  service?: string;
  /** For a Dockerfile: the build context it is relative to. */
  context?: string;
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function envFilePaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (typeof entry === "string" ? [entry] : typeof asRecord(entry)?.["path"] === "string" ? [asRecord(entry)!["path"] as string] : []));
}

export function findFileReferences(doc: unknown): FileReference[] {
  const refs: FileReference[] = [];
  const root = asRecord(doc);
  const include = root?.["include"];
  for (const entry of Array.isArray(include) ? include : []) {
    if (typeof entry === "string") { refs.push({ kind: "include", path: entry }); continue; }
    const mapping = asRecord(entry);
    if (!mapping) continue;
    for (const target of stringsOf(mapping["path"])) refs.push({ kind: "include", path: target });
    for (const target of stringsOf(mapping["project_directory"])) refs.push({ kind: "include", path: target });
    for (const target of envFilePaths(mapping["env_file"])) refs.push({ kind: "include-env_file", path: target });
  }
  for (const [name, value] of Object.entries(asRecord(root?.["services"]) ?? {})) {
    const service = asRecord(value);
    if (!service) continue;
    for (const target of envFilePaths(service["env_file"])) refs.push({ kind: "env_file", path: target, service: name });
    const extendsFile = asRecord(service["extends"])?.["file"];
    if (typeof extendsFile === "string") refs.push({ kind: "extends", path: extendsFile, service: name });
    const build = asRecord(service["build"]);
    if (typeof build?.["dockerfile"] === "string") {
      refs.push({ kind: "dockerfile", path: build["dockerfile"], service: name, context: typeof build["context"] === "string" ? build["context"] : "." });
    }
  }
  return refs;
}

const REMOTE_CONTEXT_RE = /^([a-z][a-z0-9+.-]*:\/\/|git@|github\.com\/)/i;

/** The absolute path a reference points at, or null when it cannot be known (a variable, or a
 *  remote build context). `baseDir` is the directory of the file the reference is written in. */
export function resolveReferencedPath(ref: FileReference, baseDir: string): string | null {
  if (ref.path.includes("$") || ref.path.startsWith("~")) return null;
  if (ref.kind !== "dockerfile") return path.resolve(baseDir, ref.path);
  const context = ref.context ?? ".";
  if (context.includes("$") || REMOTE_CONTEXT_RE.test(context)) return null;
  return path.resolve(baseDir, context, ref.path);
}

/** Null when the reference is fine; otherwise what is wrong with it. */
export function checkFileReference(ref: FileReference, baseDir: string, projectDir: string): PolicyViolation | null {
  const where = ref.kind === "include" || ref.kind === "include-env_file"
    ? { section: "include" as const, service: ref.path, key: ref.kind === "include" ? "path" : "env_file" }
    : { service: ref.service ?? "", key: ref.kind };
  const fix = "Keep the file inside the project folder and refer to it with a relative path.";
  if (ref.kind === "dockerfile" && (ref.context?.includes("$") || ref.path.includes("$"))) {
    return { ...where, problem: `"${ref.path}" depends on a variable, so it cannot be checked.`, fix };
  }
  if (ref.kind === "dockerfile" && ref.context && REMOTE_CONTEXT_RE.test(ref.context)) return null;
  const target = resolveReferencedPath(ref, baseDir);
  if (target === null) {
    const why = ref.path.startsWith("~") ? "starts with ~" : "depends on a variable, so it cannot be checked";
    return { ...where, problem: `"${ref.path}" ${why}.`, fix };
  }
  if (!isInsideProject(target, projectDir)) {
    return { ...where, problem: `"${ref.path}" is outside the project folder. Compose reads it from Stackport's own filesystem, which holds Stackport's secrets.`, fix };
  }
  return null;
}
