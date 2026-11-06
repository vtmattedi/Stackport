import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { initializeDatabase } from "../src/config/database";
import { requireAuth } from "../src/middleware/auth";
import { issueAuthToken } from "../src/services/authTokens";
import {
  buildClearedSessionCookie, buildSessionCookie, isSameOrigin, passesCsrfCheck, readCookie, SESSION_COOKIE,
} from "../src/services/sessionCookie";

before(() => { initializeDatabase(); });

test("the session cookie is httpOnly and SameSite=Strict, and Secure only over HTTPS", () => {
  const plain = buildSessionCookie("abc.def", { secure: false, maxAgeSeconds: 3600 });
  assert.match(plain, /^stackport_session=abc\.def; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600$/);
  assert.match(buildSessionCookie("t", { secure: true, maxAgeSeconds: 60 }), /; Secure$/);
  assert.match(buildClearedSessionCookie(true), /Max-Age=0; Secure$/);
});

test("a cookie is read by name from a header with several", () => {
  assert.equal(readCookie("a=1; stackport_session=tok%20en; b=2", SESSION_COOKIE), "tok en");
  assert.equal(readCookie("a=1; b=2", SESSION_COOKIE), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
  assert.equal(readCookie("stackport_session=%E0%A4%A", SESSION_COOKIE), null, "a malformed value is not a session");
});

test("state-changing requests need the client header, reads do not", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(passesCsrfCheck(method, undefined), true, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(passesCsrfCheck(method, undefined), false, method);
    assert.equal(passesCsrfCheck(method, "stackport"), true, method);
    assert.equal(passesCsrfCheck(method, "other"), false, method);
  }
});

test("a WebSocket handshake must come from this host", () => {
  assert.equal(isSameOrigin(undefined, "stack.example.com"), true, "not a browser");
  assert.equal(isSameOrigin("https://stack.example.com", "stack.example.com"), true);
  assert.equal(isSameOrigin("https://evil.example", "stack.example.com"), false);
  assert.equal(isSameOrigin("not a url", "stack.example.com"), false);
});

interface Outcome { status: number | null; body: unknown; cookies: string[]; headers: Record<string, string>; next: boolean; user?: string }

function run(options: { method?: string; headers?: Record<string, string> }): Outcome {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Outcome = { status: null, body: null, cookies: [], headers: {}, next: false };
  const req = { method: options.method ?? "GET", headers, secure: false, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
    setHeader(name: string, value: string) { out.headers[name] = value; return this; },
    append(name: string, value: string) { if (name === "Set-Cookie") out.cookies.push(value); return this; },
  } as unknown as Response;
  requireAuth(req, res, (() => { out.next = true; out.user = req.user; }) as NextFunction);
  return out;
}

test("a cookie session reads without the client header, and the cookie is renewed", () => {
  const token = issueAuthToken("admin");
  const out = run({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(out.next, true);
  assert.equal(out.user, "admin");
  assert.equal(out.cookies.length, 1, "a fresh cookie is set");
  assert.equal(out.headers["X-Auth-Token"], undefined, "no token in a header for cookie sessions");
});

test("a cookie session cannot change state without the client header", () => {
  const token = issueAuthToken("admin");
  const blocked = run({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.next, false);
  const allowed = run({ method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "X-Requested-With": "stackport" } });
  assert.equal(allowed.next, true);
});

test("a bearer token works for state changes with no client header and gets the header refresh", () => {
  const token = issueAuthToken("admin");
  const out = run({ method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(out.next, true);
  assert.ok(out.headers["X-Auth-Token"]);
  assert.deepEqual(out.cookies, []);
});

test("no credentials, or a bad cookie, is a 401", () => {
  assert.equal(run({}).status, 401);
  assert.equal(run({ headers: { cookie: `${SESSION_COOKIE}=not-a-token` } }).status, 401);
});
