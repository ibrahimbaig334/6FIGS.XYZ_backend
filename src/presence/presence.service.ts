import { Injectable } from "@nestjs/common";

export interface Presence {
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * In-memory online presence, fed by WS connect/disconnect.
 * Single-instance only — needs Redis for multi-instance (see SUMMARY.txt).
 */
@Injectable()
export class PresenceService {
  private sockets = new Map<string, string>(); // socketId -> userId
  private users = new Map<string, Set<string>>(); // userId -> socketIds
  private lastSeen = new Map<string, number>();

  markOnline(userId: string, socketId: string): void {
    this.sockets.set(socketId, userId);
    let set = this.users.get(userId);
    if (!set) {
      set = new Set();
      this.users.set(userId, set);
    }
    set.add(socketId);
    this.lastSeen.set(userId, Date.now());
  }

  markOffline(socketId: string): void {
    const userId = this.sockets.get(socketId);
    if (!userId) return;
    this.sockets.delete(socketId);
    const set = this.users.get(userId);
    if (set) {
      set.delete(socketId);
      if (!set.size) this.users.delete(userId);
    }
    this.lastSeen.set(userId, Date.now());
  }

  status(userId: string): Presence {
    const ts = this.lastSeen.get(userId);
    return { online: this.users.has(userId), lastSeenAt: ts ? new Date(ts).toISOString() : null };
  }
}
