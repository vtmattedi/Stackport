import rateLimit from "express-rate-limit";

// Sized from measured client traffic once polling was replaced by socket events and
// the action tracker (October 2026): a full page load costs about 11 API requests,
// in-app navigation fewer (54 page changes cost 122), and an idle page none. A busy
// 15 minutes (a page change every 10 s plus some reloads) is roughly 200-300; 600
// leaves room for a second tab while still bounding runaway or abusive traffic.
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
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
