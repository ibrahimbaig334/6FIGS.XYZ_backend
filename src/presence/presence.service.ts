import { Injectable } from "@nestjs/common";

export interface Presence {
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * In-memory online presence, fed by WS connect/disconnect.
 * Single-instance only — needs Redis for multi-instance (see SUMMARY.txt).
 *
 * Two layers:
 * - global online: any socket connected (drives friend dots, offline checks).
 * - room occupancy: sockets that joined a chat scope (drives live room counts).
 *   Closing a tab fires WS disconnect, which untracks the socket everywhere —
 *   no Leave click needed for the count to drop.
 */
@Injectable()
export class PresenceService {
  private sockets = new Map<string, string>(); // socketId -> userId
  private users = new Map<string, Set<string>>(); // userId -> socketIds
  private lastSeen = new Map<string, number>();
  private rooms = new Map<string, Map<string, Set<string>>>(); // scopeKey -> userId -> socketIds

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
    this.untrackSocket(socketId);
  }

  status(userId: string): Presence {
    const ts = this.lastSeen.get(userId);
    return { online: this.users.has(userId), lastSeenAt: ts ? new Date(ts).toISOString() : null };
  }

  /** Socket entered a chat scope (joinScope) — occupant of roomKey (`room:id` / `dm:id`). */
  trackJoin(socketId: string, userId: string, roomKey: string): void {
    let room = this.rooms.get(roomKey);
    if (!room) {
      room = new Map();
      this.rooms.set(roomKey, room);
    }
    let set = room.get(userId);
    if (!set) {
      set = new Set();
      room.set(userId, set);
    }
    set.add(socketId);
  }

  /** Socket left a chat scope (leaveScope / scope rejoin). */
  trackLeave(socketId: string, roomKey: string): void {
    const room = this.rooms.get(roomKey);
    if (!room) return;
    for (const [userId, set] of room) {
      set.delete(socketId);
      if (!set.size) room.delete(userId);
    }
    if (!room.size) this.rooms.delete(roomKey);
  }

  /** Socket gone (disconnect / new session) — drop it from every scope. */
  untrackSocket(socketId: string): void {
    for (const [roomKey, room] of this.rooms) {
      for (const [userId, set] of room) {
        set.delete(socketId);
        if (!set.size) room.delete(userId);
      }
      if (!room.size) this.rooms.delete(roomKey);
    }
  }

  /** Distinct users currently inside a chat scope — the live room count. */
  countInRoom(roomKey: string): number {
    return this.rooms.get(roomKey)?.size ?? 0;
  }
}
