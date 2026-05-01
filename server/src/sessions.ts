import { randomBytes } from "node:crypto";

export const SESSION_PREFIX = "mws_";
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_EVERY = 1024;

interface Session {
  expiresAt: number;
}

const sessions = new Map<string, Session>();
let opsSinceCleanup = 0;

function maybeCleanup(): void {
  if (++opsSinceCleanup < CLEANUP_EVERY) return;
  opsSinceCleanup = 0;
  const now = Date.now();
  for (const [token, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(token);
  }
}

export function createSession(): string {
  maybeCleanup();
  const token = SESSION_PREFIX + randomBytes(24).toString("hex");
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function validateSession(token: string): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function revokeSession(token: string): void {
  sessions.delete(token);
}
