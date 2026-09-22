import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

interface Entry {
  exp: number;
  value: unknown;
}

/**
 * Hot-GET cache. Uses Redis when REDIS_URL is set, otherwise an in-memory
 * TTL map (single instance). All methods are async; callers must await.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly log = new Logger("CacheService");
  private readonly mem = new Map<string, Entry>();
  private redis: Redis | null = null;
  private redisOk = false;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      const client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // fail fast — memory fallback covers us
      });
      client.on("error", () => {
        if (this.redisOk) this.log.warn("Redis error — falling back to memory cache");
        this.redisOk = false;
      });
      client
        .connect()
        .then(() => {
          this.redisOk = true;
          this.log.log("Redis cache connected");
        })
        .catch(() => {
          this.log.warn("Redis unreachable — using memory cache");
        });
      this.redis = client;
    } catch {
      this.redis = null;
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.redis && this.redisOk) {
      try {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as T;
      } catch {
        this.redisOk = false;
      }
    }
    const e = this.mem.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.mem.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.mem.set(key, { exp: Date.now() + ttlMs, value });
    if (this.redis && this.redisOk) {
      try {
        await this.redis.set(key, JSON.stringify(value), "PX", ttlMs);
      } catch {
        this.redisOk = false;
      }
    }
  }

  async del(key: string): Promise<void> {
    this.mem.delete(key);
    if (this.redis && this.redisOk) {
      try {
        await this.redis.del(key);
      } catch {
        this.redisOk = false;
      }
    }
  }
}
