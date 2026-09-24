import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Redis-only hot-GET cache. The backend refuses to boot without Redis
 * (REDIS_URL): if the connection fails at startup, init throws and Nest dies.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("CacheService");
  private redis!: Redis;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set — backend requires Redis to start");
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy: () => null, // fail fast at boot; runtime blips surface as errors
    });
    try {
      await client.connect();
      await client.ping();
    } catch (err) {
      client.disconnect();
      throw new Error(`Redis unreachable — backend requires Redis to start: ${err instanceof Error ? err.message : err}`);
    }
    this.redis = client;
    this.log.log("Redis cache connected");
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), "PX", ttlMs);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /** SET NX lock — waits up to waitMs for acquisition. Returns false if timed out. */
  async lock(key: string, ttlMs: number, waitMs = 2000): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const ok = await this.redis.set(key, "1", "PX", ttlMs, "NX");
      if (ok === "OK") return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async unlock(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async delPrefix(prefix: string): Promise<void> {
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== "0");
  }
}
