/**
 * Backend tunables — change here and the whole backend follows.
 * Leaf module: imports nothing (never create cycles through this file).
 */

// Rooms
export const ROOM_CAPACITY = 2; // 1v1 — members per room
export const MAX_ROOMS_PER_USER = 3; // rooms one user may own
export const ROOM_NAME_MIN = 3;
export const ROOM_NAME_MAX = 48;
export const ROOM_DESC_MAX = 160;
export const INVITE_CODE_MIN = 4;
export const ROOMS_CACHE_MS = 15_000; // roster list cache (presence is always fresh)
export const ROOM_GAME_LOCK_MS = 5_000;
export const LOCK_WAIT_MS = 2_000;

// Chat
export const MSG_MAX_LEN = 240;
export const TICKERS_PER_MSG = 3;

// Profiles
export const HANDLE_PATTERN = /^[a-zA-Z0-9_.]{3,24}$/;

// Auth
export const NONCE_TTL_MS = 10 * 60 * 1000;
export const JWT_EXPIRES_IN = "7d";
export const MAX_WALLETS_PER_USER = 20;

// Eligibility / balances
export const ELIGIBILITY_TTL_MS = 24 * 3600 * 1000;
export const BAL_CACHE_MS = 10 * 60 * 1000; // native RPC balances reusable this long

// Market data
export const TOKEN_CACHE_MS = 5 * 60 * 1000;
export const TOKEN_PENDING_MS = 60 * 1000;
export const COINGECKO_API = "https://api.coingecko.com/api/v3";

// Matchmaking
export const QUEUE_TICKET_TTL_MS = 2 * 60 * 1000;
export const FRESH_MATCH_MS = 5 * 60 * 1000;
export const QUEUE_LOCK_MS = 5_000;

// Games
export const REMATCH_OFFER_MS = 15_000; // rematch toast window (accept/decline)

// Listing defaults
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;
