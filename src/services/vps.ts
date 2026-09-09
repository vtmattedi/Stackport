import { config } from "../config/env";
import { getDatabase } from "../config/database";
import { decryptSecret, encryptSecret } from "../utils/crypto";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const HOSTINGER_BASE = "https://developers.hostinger.com";

export interface VpsProvider {
  id: number;
  type: "hostinger";
  name: string;
  hasApiKey: boolean;
  credentialId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface VpsProviderRow {
  id: number;
  type: string;
  name: string;
  credential_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface MonitoredVm {
  id: number;
  providerId: number;
  vmId: string;
  label: string | null;
  createdAt: string;
}

export interface MonitoredVmRow {
  id: number;
  provider_id: number;
  vm_id: string;
  label: string | null;
  created_at: string;
}

export interface VmCacheRow {
  provider_id: number;
  vm_id: string;
  data_json: string;
  fetched_at: string;
}

export interface VpsSnapshot {
  configured: boolean;
  providers: VpsProvider[];
  monitored: MonitoredVm[];
  vms: AnyObj[];
  vps: AnyObj | null;
}

export type FirewallAction = "accept" | "drop";
export type FirewallProtocol = "TCP" | "UDP" | "ICMP" | "GRE" | "any" | "ESP" | "AH" | "ICMPv6" | "SSH" | "HTTP" | "HTTPS" | "MySQL" | "PostgreSQL";
export type FirewallSource = "any" | "custom";

export interface FirewallRule {
  id: number;
  profileId: number;
  action: FirewallAction;
  protocol: FirewallProtocol;
  port: string;
  source: FirewallSource;
  sourceDetail: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface FirewallProfile {
  id: number;
  providerId: number;
  name: string;
  remoteFirewallId: string | null;
  rules: FirewallRule[];
  createdAt: string;
  updatedAt: string;
}

export interface FirewallProfileRow {
  id: number;
  provider_id: number;
  name: string;
  remote_firewall_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FirewallRuleRow {
  id: number;
  profile_id: number;
  action: string;
  protocol: string;
  port: string;
  source: string;
  source_detail: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface FirewallSyncResult {
  profile: FirewallProfile;
  firewall: AnyObj;
  createdRemote: boolean;
  deletedRules: number;
  createdRules: number;
  activate: AnyObj | null;
  sync: AnyObj | null;
}

const FIREWALL_PROTOCOLS = new Set<FirewallProtocol>(["TCP", "UDP", "ICMP", "GRE", "any", "ESP", "AH", "ICMPv6", "SSH", "HTTP", "HTTPS", "MySQL", "PostgreSQL"]);

function rowToProvider(row: VpsProviderRow): VpsProvider {
  return {
    id: row.id,
    type: "hostinger",
    name: row.name,
    hasApiKey: row.credential_id != null,
    credentialId: row.credential_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMonitored(row: MonitoredVmRow): MonitoredVm {
  return {
    id: row.id,
    providerId: row.provider_id,
    vmId: row.vm_id,
    label: row.label,
    createdAt: row.created_at,
  };
}

export function listProviders(): VpsProvider[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM vps_providers ORDER BY name ASC")
    .all() as VpsProviderRow[];
  return rows.map(rowToProvider);
}

export function getProvider(id: number): VpsProviderRow | null {
  return getDatabase().prepare("SELECT * FROM vps_providers WHERE id = ?").get(id) as VpsProviderRow | undefined ?? null;
}

function findApiKeyCredential(credentialId: number): { id: number } | undefined {
  return getDatabase().prepare("SELECT id FROM credentials WHERE id = ? AND type = 'api_key'").get(credentialId) as { id: number } | undefined;
}

export function saveHostingerProvider(name: string, credentialId?: number | null, providerId?: number): VpsProvider {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = providerId
    ? db.prepare("SELECT * FROM vps_providers WHERE id = ? AND type = 'hostinger'").get(providerId) as VpsProviderRow | undefined
    : undefined;
  if (providerId && !existing) {
    throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  }
  if (credentialId != null && !findApiKeyCredential(credentialId)) {
    throw Object.assign(new Error("API key credential not found"), { status: 400 });
  }
  if (existing) {
    if (credentialId !== undefined) {
      db.prepare("UPDATE vps_providers SET name = ?, credential_id = ?, updated_at = ? WHERE id = ?")
        .run(name, credentialId, now, existing.id);
    } else {
      db.prepare("UPDATE vps_providers SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, now, existing.id);
    }
    return rowToProvider(db.prepare("SELECT * FROM vps_providers WHERE id = ?").get(existing.id) as VpsProviderRow);
  }
  if (credentialId == null) {
    throw Object.assign(new Error("credentialId is required"), { status: 400 });
  }
  const result = db.prepare(
    "INSERT INTO vps_providers (type, name, credential_id, created_at, updated_at) VALUES ('hostinger', ?, ?, ?, ?)"
  ).run(name, credentialId, now, now);
  return rowToProvider(db.prepare("SELECT * FROM vps_providers WHERE id = ?").get(result.lastInsertRowid) as VpsProviderRow);
}

export const upsertHostingerProvider = saveHostingerProvider;

export function listMonitoredVms(): MonitoredVm[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM vps_monitored_vms ORDER BY label ASC, vm_id ASC")
    .all() as MonitoredVmRow[];
  return rows.map(rowToMonitored);
}

export function addMonitoredVm(providerId: number, vmId: string, label: string | null): MonitoredVm {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO vps_monitored_vms (provider_id, vm_id, label, created_at) VALUES (?, ?, ?, ?)")
    .run(providerId, vmId, label, now);
  const row = db.prepare("SELECT * FROM vps_monitored_vms WHERE provider_id = ? AND vm_id = ?")
    .get(providerId, vmId) as MonitoredVmRow;
  return rowToMonitored(row);
}

export function removeMonitoredVm(id: number): boolean {
  return getDatabase().prepare("DELETE FROM vps_monitored_vms WHERE id = ?").run(id).changes > 0;
}

function providerApiKey(provider: VpsProviderRow): string {
  if (provider.credential_id == null) {
    throw Object.assign(new Error("VPS provider has no API key configured"), { status: 400 });
  }
  const cred = getDatabase().prepare("SELECT secret_enc FROM credentials WHERE id = ?").get(provider.credential_id) as { secret_enc: string } | undefined;
  if (!cred) {
    throw Object.assign(new Error("VPS provider API key credential not found"), { status: 400 });
  }
  return decryptSecret(cred.secret_enc);
}

function ensureApiKeyCredential(alias: string, secret: string): number {
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM credentials WHERE alias = ?").get(alias) as { id: number } | undefined;
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const result = db.prepare(
    "INSERT INTO credentials (type, alias, secret_enc, is_default, created_at, updated_at) VALUES ('api_key', ?, ?, 0, ?, ?)"
  ).run(alias, encryptSecret(secret), now, now);
  return Number(result.lastInsertRowid);
}

async function hostingerFetch(provider: VpsProviderRow, method: string, apiPath: string): Promise<AnyObj> {
  const res = await fetch(`${HOSTINGER_BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${providerApiKey(provider)}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({ error: "Non-JSON response" })) as AnyObj;
  if (!res.ok) {
    const err = new Error(`Hostinger API ${res.status}`) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function hostingerFetchBody(provider: VpsProviderRow, method: string, apiPath: string, body?: unknown): Promise<AnyObj> {
  const res = await fetch(`${HOSTINGER_BASE}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${providerApiKey(provider)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({ error: "Non-JSON response" })) as AnyObj;
  if (!res.ok) {
    const err = new Error(`Hostinger API ${res.status}`) as Error & { status: number; body: unknown };
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function unwrapList(body: AnyObj): AnyObj[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data as AnyObj[];
  return [];
}

function vmPath(vmId: string, suffix = ""): string {
  return `/api/vps/v1/virtual-machines/${vmId}${suffix}`;
}

function firewallPath(firewallId = "", suffix = ""): string {
  return `/api/vps/v1/firewall${firewallId ? `/${firewallId}` : ""}${suffix}`;
}

function rowToFirewallRule(row: FirewallRuleRow): FirewallRule {
  return {
    id: row.id,
    profileId: row.profile_id,
    action: row.action === "drop" ? "drop" : "accept",
    protocol: FIREWALL_PROTOCOLS.has(row.protocol as FirewallProtocol) ? row.protocol as FirewallProtocol : "TCP",
    port: row.port,
    source: row.source === "custom" ? "custom" : "any",
    sourceDetail: row.source_detail,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rulesForProfile(profileId: number): FirewallRule[] {
  const rows = getDatabase()
    .prepare("SELECT * FROM firewall_rules WHERE profile_id = ? ORDER BY position ASC, id ASC")
    .all(profileId) as FirewallRuleRow[];
  return rows.map(rowToFirewallRule);
}

function rowToFirewallProfile(row: FirewallProfileRow): FirewallProfile {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    remoteFirewallId: row.remote_firewall_id,
    rules: rulesForProfile(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeFirewallRuleInput(input: Record<string, unknown>): Omit<FirewallRule, "id" | "profileId" | "position" | "createdAt" | "updatedAt"> {
  const action = input.action === "drop" ? "drop" : "accept";
  const protocol = typeof input.protocol === "string" && FIREWALL_PROTOCOLS.has(input.protocol as FirewallProtocol)
    ? input.protocol as FirewallProtocol
    : null;
  const port = typeof input.port === "string" ? input.port.trim() : String(input.port ?? "").trim();
  const source = input.source === "custom" ? "custom" : "any";
  const sourceDetail = source === "any" ? "any" : typeof input.sourceDetail === "string"
    ? input.sourceDetail.trim()
    : typeof input.source_detail === "string"
      ? input.source_detail.trim()
      : "";
  if (!protocol) throw Object.assign(new Error("Invalid firewall protocol"), { status: 400 });
  if (!port) throw Object.assign(new Error("Firewall port is required"), { status: 400 });
  if (source === "custom" && !sourceDetail) throw Object.assign(new Error("Custom source detail is required"), { status: 400 });
  return { action, protocol, port: port.slice(0, 32), source, sourceDetail: sourceDetail.slice(0, 120) };
}

export function listFirewallProfiles(providerId?: number): FirewallProfile[] {
  const db = getDatabase();
  const rows = providerId
    ? db.prepare("SELECT * FROM firewall_profiles WHERE provider_id = ? ORDER BY updated_at DESC").all(providerId)
    : db.prepare("SELECT * FROM firewall_profiles ORDER BY updated_at DESC").all();
  return (rows as FirewallProfileRow[]).map(rowToFirewallProfile);
}

export function getFirewallProfile(profileId: number): FirewallProfile | null {
  const row = getDatabase().prepare("SELECT * FROM firewall_profiles WHERE id = ?").get(profileId) as FirewallProfileRow | undefined;
  return row ? rowToFirewallProfile(row) : null;
}

export function createFirewallProfile(providerId: number, name: string, remoteFirewallId?: string | null): FirewallProfile {
  if (!getProvider(providerId)) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare("INSERT INTO firewall_profiles (provider_id, name, remote_firewall_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(providerId, name.trim().slice(0, 80) || "Stackport Firewall", remoteFirewallId?.trim() || null, now, now);
  return getFirewallProfile(Number(result.lastInsertRowid)) as FirewallProfile;
}

export function updateFirewallProfile(profileId: number, data: { name?: string; remoteFirewallId?: string | null }): FirewallProfile {
  const existing = getFirewallProfile(profileId);
  if (!existing) throw Object.assign(new Error("Firewall profile not found"), { status: 404 });
  const now = new Date().toISOString();
  getDatabase()
    .prepare("UPDATE firewall_profiles SET name = ?, remote_firewall_id = ?, updated_at = ? WHERE id = ?")
    .run(
      data.name?.trim().slice(0, 80) || existing.name,
      data.remoteFirewallId === undefined ? existing.remoteFirewallId : data.remoteFirewallId?.trim() || null,
      now,
      profileId
    );
  return getFirewallProfile(profileId) as FirewallProfile;
}

export function deleteFirewallProfile(profileId: number): boolean {
  return getDatabase().prepare("DELETE FROM firewall_profiles WHERE id = ?").run(profileId).changes > 0;
}

export function createFirewallRule(profileId: number, input: Record<string, unknown>): FirewallRule {
  const profile = getFirewallProfile(profileId);
  if (!profile) throw Object.assign(new Error("Firewall profile not found"), { status: 404 });
  const rule = normalizeFirewallRuleInput(input);
  const now = new Date().toISOString();
  const position = (getDatabase()
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM firewall_rules WHERE profile_id = ?")
    .get(profileId) as { next: number }).next;
  const result = getDatabase()
    .prepare(`INSERT INTO firewall_rules
      (profile_id, action, protocol, port, source, source_detail, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(profileId, rule.action, rule.protocol, rule.port, rule.source, rule.sourceDetail, position, now, now);
  getDatabase().prepare("UPDATE firewall_profiles SET updated_at = ? WHERE id = ?").run(now, profileId);
  const row = getDatabase().prepare("SELECT * FROM firewall_rules WHERE id = ?").get(result.lastInsertRowid) as FirewallRuleRow;
  return rowToFirewallRule(row);
}

export function deleteFirewallRule(profileId: number, ruleId: number): boolean {
  const changed = getDatabase()
    .prepare("DELETE FROM firewall_rules WHERE profile_id = ? AND id = ?")
    .run(profileId, ruleId).changes > 0;
  if (changed) {
    getDatabase().prepare("UPDATE firewall_profiles SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), profileId);
  }
  return changed;
}

export async function listProviderFirewalls(providerId: number): Promise<AnyObj[]> {
  const provider = getProvider(providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  return unwrapList(await hostingerFetch(provider, "GET", firewallPath()));
}

export async function getProviderFirewall(providerId: number, firewallId: string): Promise<AnyObj> {
  const provider = getProvider(providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  return hostingerFetch(provider, "GET", firewallPath(encodeURIComponent(firewallId)));
}

function remoteRulePayload(rule: FirewallRule): AnyObj {
  return {
    action: rule.action,
    protocol: rule.protocol,
    port: rule.port,
    source: rule.source,
    source_detail: rule.sourceDetail,
  };
}

function remoteRules(firewall: AnyObj): AnyObj[] {
  if (Array.isArray(firewall.rules)) return firewall.rules as AnyObj[];
  if (firewall.data && typeof firewall.data === "object" && Array.isArray((firewall.data as AnyObj).rules)) {
    return (firewall.data as AnyObj).rules as AnyObj[];
  }
  return [];
}

export async function syncFirewallProfile(profileId: number, options: { vmId?: string | null; activate?: boolean }): Promise<FirewallSyncResult> {
  let profile = getFirewallProfile(profileId);
  if (!profile) throw Object.assign(new Error("Firewall profile not found"), { status: 404 });
  const provider = getProvider(profile.providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  if (profile.rules.length === 0) throw Object.assign(new Error("Add at least one firewall rule before syncing"), { status: 400 });

  let createdRemote = false;
  let firewallId = profile.remoteFirewallId;
  if (!firewallId) {
    const created = await hostingerFetchBody(provider, "POST", firewallPath(), { name: profile.name });
    firewallId = String(created.id ?? (created.data as AnyObj | undefined)?.id ?? "");
    if (!firewallId) throw Object.assign(new Error("Hostinger did not return a firewall id"), { status: 502 });
    profile = updateFirewallProfile(profile.id, { remoteFirewallId: firewallId });
    createdRemote = true;
  }

  const before = await getProviderFirewall(profile.providerId, firewallId);
  let deletedRules = 0;
  for (const rule of remoteRules(before)) {
    const ruleId = rule.id == null ? "" : String(rule.id);
    if (!ruleId) continue;
    await hostingerFetchBody(provider, "DELETE", `${firewallPath(encodeURIComponent(firewallId), "/rules")}/${encodeURIComponent(ruleId)}`);
    deletedRules += 1;
  }

  let createdRules = 0;
  for (const rule of profile.rules) {
    await hostingerFetchBody(provider, "POST", firewallPath(encodeURIComponent(firewallId), "/rules"), remoteRulePayload(rule));
    createdRules += 1;
  }

  let activate: AnyObj | null = null;
  let sync: AnyObj | null = null;
  if (options.vmId) {
    const encodedVm = encodeURIComponent(options.vmId);
    if (options.activate) {
      activate = await hostingerFetchBody(provider, "POST", firewallPath(encodeURIComponent(firewallId), `/activate/${encodedVm}`));
    }
    sync = await hostingerFetchBody(provider, "POST", firewallPath(encodeURIComponent(firewallId), `/sync/${encodedVm}`));
  }

  const firewall = await getProviderFirewall(profile.providerId, firewallId);
  return { profile, firewall, createdRemote, deletedRules, createdRules, activate, sync };
}

export async function listAvailableVms(providerId: number): Promise<AnyObj[]> {
  const provider = getProvider(providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  return unwrapList(await hostingerFetch(provider, "GET", "/api/vps/v1/virtual-machines"));
}

function valuesFromUsageMap(v: unknown): number[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const usage = (v as AnyObj).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return [];
  return Object.values(usage).filter((n): n is number => typeof n === "number" && isFinite(n));
}

function latestFromUsageMap(v: unknown): number | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const usage = (v as AnyObj).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const latest = Object.entries(usage)
    .map(([ts, value]) => ({ ts: Number(ts), value }))
    .filter((p): p is { ts: number; value: number } => isFinite(p.ts) && typeof p.value === "number" && isFinite(p.value))
    .sort((a, b) => b.ts - a.ts)[0];
  return latest?.value ?? null;
}

function extractAvg(obj: AnyObj, ...keys: string[]): number {
  for (const key of keys) {
    const v = obj?.[key];
    if (v == null) continue;
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "object" && !Array.isArray(v) && typeof v.average === "number") return v.average;
    const usageNums = valuesFromUsageMap(v);
    if (usageNums.length) return usageNums.reduce((a, b) => a + b, 0) / usageNums.length;
    if (Array.isArray(v) && v.length > 0) {
      const nums = (v as AnyObj[]).map((p) => typeof p === "number" ? p : p?.value ?? p?.usage_percent ?? p?.usage_bytes ?? p?.bytes ?? null)
        .filter((n): n is number => typeof n === "number" && isFinite(n));
      if (nums.length) return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    if (typeof v === "object" && Array.isArray(v.data) && v.data.length > 0) {
      const nums = (v.data as AnyObj[]).map((p) => p?.value ?? p?.usage_percent ?? p?.usage_bytes ?? p?.bytes ?? null)
        .filter((n): n is number => typeof n === "number" && isFinite(n));
      if (nums.length) return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
  }
  return 0;
}

function extractSum(obj: AnyObj, ...keys: string[]): number {
  for (const key of keys) {
    const v = obj?.[key];
    if (v == null) continue;
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "object" && !Array.isArray(v) && typeof v.total === "number") return v.total;
    const usageNums = valuesFromUsageMap(v);
    if (usageNums.length) return usageNums.reduce((a, b) => a + b, 0);
    if (Array.isArray(v) && v.length > 0) {
      return (v as AnyObj[]).map((p) => typeof p === "number" ? p : p?.value ?? p?.bytes ?? 0)
        .filter((n): n is number => typeof n === "number" && isFinite(n)).reduce((a, b) => a + b, 0);
    }
    if (typeof v === "object" && Array.isArray(v.data) && v.data.length > 0) {
      return (v.data as AnyObj[]).map((p) => p?.value ?? p?.bytes ?? 0)
        .filter((n): n is number => typeof n === "number" && isFinite(n)).reduce((a, b) => a + b, 0);
    }
  }
  return 0;
}

function extractLatest(obj: AnyObj, ...keys: string[]): number {
  for (const key of keys) {
    const v = obj?.[key];
    if (v == null) continue;
    if (typeof v === "number" && isFinite(v)) return v;
    const latestUsage = latestFromUsageMap(v);
    if (latestUsage != null) return latestUsage;
    if (Array.isArray(v) && v.length > 0) {
      const nums = (v as AnyObj[]).map((p) => typeof p === "number" ? p : p?.value ?? p?.usage_percent ?? p?.usage_bytes ?? p?.bytes ?? null)
        .filter((n): n is number => typeof n === "number" && isFinite(n));
      if (nums.length) return nums[nums.length - 1];
    }
    if (typeof v === "object" && Array.isArray(v.data) && v.data.length > 0) {
      const nums = (v.data as AnyObj[]).map((p) => p?.value ?? p?.usage_percent ?? p?.usage_bytes ?? p?.bytes ?? null)
        .filter((n): n is number => typeof n === "number" && isFinite(n));
      if (nums.length) return nums[nums.length - 1];
    }
  }
  return 0;
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function normalizeVps(info: AnyObj, metrics: AnyObj): AnyObj {
  const totalRamBytes = safeNum(info.memory ?? info.ram) * 1024 * 1024;
  const totalDiskBytes = safeNum(info.disk ?? info.disk_size) * 1024 * 1024;
  const cpus: number = safeNum(info.cpus ?? info.cpu_count) || 1;
  const m: AnyObj = metrics?.data && typeof metrics.data === "object" && !Array.isArray(metrics.data)
    ? (metrics.data as AnyObj)
    : metrics?.metrics && typeof metrics.metrics === "object" && !Array.isArray(metrics.metrics)
      ? (metrics.metrics as AnyObj)
      : metrics;
  const cpuPct = extractAvg(m, "cpu_usage", "cpu_usage_percent", "cpu", "cpuUsage", "cpu_percent");
  const ramBytes = extractAvg(m, "memory_used", "memory_usage", "memory_used_bytes", "ram_used", "ram_usage", "ram_usage_bytes", "memory", "ram");
  const diskBytes = extractAvg(m, "disk_used", "disk_usage", "disk_space", "disk_used_bytes", "disk_usage_bytes", "disk");
  const netInBytes = extractSum(m, "network_incoming_traffic", "incoming_traffic", "network_in", "network_rx_bytes", "rx_bytes", "inbound", "bytes_in", "incoming_bandwidth");
  const netOutBytes = extractSum(m, "network_outgoing_traffic", "outgoing_traffic", "network_out", "network_tx_bytes", "tx_bytes", "outbound", "bytes_out", "outgoing_bandwidth");
  let uptimeSec = 0;
  for (const src of [info.uptime_seconds, info.uptime, metrics?.uptime_seconds, metrics?.uptime, extractLatest(m, "uptime")]) {
    if (typeof src === "number" && isFinite(src) && src > 0) { uptimeSec = src; break; }
  }
  const ipAddresses = Array.isArray(info.ip_addresses)
    ? (info.ip_addresses as AnyObj[]).map((a) => a.address ?? a).filter(Boolean)
    : [];
  return {
    providerId: info.providerId,
    id: info.id,
    hostname: info.hostname,
    state: info.state,
    cpus,
    plan: info.plan ?? info.template?.name,
    ipAddresses,
    cpu: { pct: cpuPct },
    ram: { bytes: ramBytes, totalBytes: totalRamBytes },
    disk: { bytes: diskBytes, totalBytes: totalDiskBytes },
    network: { inBytes: netInBytes, outBytes: netOutBytes },
    uptimeSec,
    fetchedAt: new Date().toISOString(),
  };
}

export async function refreshVm(providerId: number, vmId: string): Promise<AnyObj> {
  const provider = getProvider(providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  const dateTo = new Date();
  const dateFrom = new Date(dateTo.getTime() - 60 * 60 * 1000);
  const qs = new URLSearchParams({ date_from: dateFrom.toISOString(), date_to: dateTo.toISOString() });
  const [infoResult, metricsResult] = await Promise.allSettled([
    hostingerFetch(provider, "GET", vmPath(vmId)),
    hostingerFetch(provider, "GET", `${vmPath(vmId, "/metrics")}?${qs}`),
  ]);
  const infoData = infoResult.status === "fulfilled" ? infoResult.value : { id: vmId };
  const metricsData = metricsResult.status === "fulfilled" ? metricsResult.value : {};
  const normalized = normalizeVps({ ...infoData, providerId }, metricsData);
  getDatabase().prepare(
    `INSERT INTO vps_vm_cache (provider_id, vm_id, data_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_id, vm_id) DO UPDATE SET data_json = excluded.data_json, fetched_at = excluded.fetched_at`
  ).run(providerId, vmId, JSON.stringify(normalized), normalized.fetchedAt);
  return normalized;
}

export function cachedVms(): AnyObj[] {
  const rows = getDatabase().prepare("SELECT * FROM vps_vm_cache ORDER BY fetched_at DESC").all() as VmCacheRow[];
  return rows.map((row) => {
    try {
      return JSON.parse(row.data_json) as AnyObj;
    } catch {
      return { providerId: row.provider_id, id: row.vm_id, fetchedAt: row.fetched_at };
    }
  });
}

export async function refreshMonitoredVms(): Promise<AnyObj[]> {
  const monitored = listMonitoredVms();
  const refreshed = await Promise.allSettled(monitored.map((vm) => refreshVm(vm.providerId, vm.vmId)));
  return refreshed
    .filter((result): result is PromiseFulfilledResult<AnyObj> => result.status === "fulfilled")
    .map((result) => result.value);
}

export async function refreshAndSnapshot(): Promise<VpsSnapshot> {
  await refreshMonitoredVms();
  return snapshot();
}

export async function snapshot(): Promise<VpsSnapshot> {
  const providers = listProviders();
  const monitored = listMonitoredVms();
  const vms = cachedVms();
  if (providers.length === 0 && config.hostingerApiKey) {
    const credentialId = ensureApiKeyCredential("hostinger-env", config.hostingerApiKey);
    const provider = upsertHostingerProvider("Hostinger", credentialId);
    if (config.hostingerVmId) addMonitoredVm(provider.id, config.hostingerVmId, null);
    return snapshot();
  }
  return {
    configured: providers.some((provider) => provider.hasApiKey),
    providers,
    monitored,
    vms,
    vps: vms[0] ?? null,
  };
}

export async function resetVm(providerId: number, vmId: string): Promise<AnyObj> {
  const provider = getProvider(providerId);
  if (!provider) throw Object.assign(new Error("VPS provider not found"), { status: 404 });
  return hostingerFetch(provider, "POST", vmPath(vmId, "/restart"));
}
