/**
 * Central env access. Required vars throw a clear boot error instead of
 * silently falling back to insecure/dev defaults. Call assertEnv() first
 * thing in main.ts so a misconfigured server dies immediately with the full
 * missing list (rather than failing mysteriously on first use).
 */
const cache = new Map<string, string>();

export function requiredEnv(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const v = (process.env[name] ?? "").trim();
  if (!v)
    throw new Error(
      `${name} is not set — add it to backend/.env (see backend/.env.example)`,
    );
  cache.set(name, v);
  return v;
}

const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "REDIS_URL", "CHAIN_MODE"];

export function assertEnv(): void {
  const missing = REQUIRED.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")} — copy backend/.env.example to backend/.env and fill them in`,
    );
  }
}
