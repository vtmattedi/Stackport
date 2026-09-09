import rateLimit from "express-rate-limit";

// The app's own UI is legitimately polling-heavy: every non-WS-tracked action
// (pull/stop/stop-purge/drop-volumes, SSL issuance, nginx apply, docker prune,
// certbot) polls its status endpoint every 1.5s while running — a single ~45s
// docker prune alone is ~30 requests. A ProjectDetails page left open also
// re-fetches GET /projects/:id/resources on each 5-minute history-bucket
// rollover (WS-pushed, not client-polled — see project:resource-sample).
// 1000/15min leaves comfortable headroom over that (including several
// concurrent actions and multiple tabs) while still bounding genuinely
// runaway or abusive traffic.
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Stricter limit for the login endpoint to slow brute-force attempts
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
  skipSuccessfulRequests: true,
});
