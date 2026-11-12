import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../modules/identity/middleware/session";
import { listApiTokens } from "../../modules/identity/apiTokens";
import { isStatusStreamEnabled, setStatusStreamEnabled, statusStreamInstanceId } from "../../modules/status/settings";
import { getStatusStream, STREAM_PATH, DEFAULT_LIMITS } from "../../transports/status/stream";
import { auditLog } from "../../shared/logger";

/** Settings > Live status: turn the stream on or off, and see who is connected. Admin session only. */
const router = Router();
router.use(requireAuth);

function describe() {
  const now = Date.now();
  const tokens = listApiTokens().filter((token) => token.scopes.includes("status") && !token.revokedAt && !(token.expiresAt && Date.parse(token.expiresAt) <= now));
  return {
    enabled: isStatusStreamEnabled(),
    path: STREAM_PATH,
    instance: statusStreamInstanceId(),
    // What the server enforces, so the page never states numbers of its own.
    limits: {
      maxConnections: DEFAULT_LIMITS.maxConnections,
      maxConnectionsPerToken: DEFAULT_LIMITS.maxConnectionsPerToken,
      maxFailuresPerAddress: DEFAULT_LIMITS.maxFailuresPerAddress,
      lockoutMinutes: Math.round(DEFAULT_LIMITS.failureWindowMs / 60_000),
      revalidateSeconds: Math.round(DEFAULT_LIMITS.revalidateMs / 1000),
      heartbeatSeconds: Math.round(DEFAULT_LIMITS.heartbeatMs / 1000),
    },
    tokens: tokens.length,
    connections: (getStatusStream()?.connections() ?? []).map((connection) => ({ tokenName: connection.tokenName, address: connection.address, since: connection.since, group: connection.group })),
  };
}

router.get("/", (_req: Request, res: Response): void => {
  res.json(describe());
});

router.put("/", (req: Request, res: Response): void => {
  const enabled: unknown = req.body?.enabled;
  if (typeof enabled !== "boolean") { res.status(400).json({ error: "enabled must be true or false" }); return; }
  setStatusStreamEnabled(enabled);
  // Turned off means off now, not when each connection next checks.
  if (!enabled) getStatusStream()?.disconnectAll("stream disabled");
  auditLog(req.user ?? "unknown", enabled ? "status-stream.enable" : "status-stream.disable", "status-stream", "ok");
  res.json(describe());
});

export default router;
