const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;

const failures = new Map<string, number[]>();

function prune(ip: string, now: number): number[] {
  const arr = failures.get(ip);
  if (!arr) return [];
  const recent = arr.filter((t) => now - t < WINDOW_MS);
  if (recent.length === 0) failures.delete(ip);
  else failures.set(ip, recent);
  return recent;
}

export function checkLoginAllowed(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const recent = prune(ip, now);
  if (recent.length < MAX_FAILURES) return { allowed: true };
  const oldest = recent[0];
  const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
  return { allowed: false, retryAfter };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const recent = prune(ip, now);
  recent.push(now);
  failures.set(ip, recent);
}

export function resetLoginFailures(ip: string): void {
  failures.delete(ip);
}
