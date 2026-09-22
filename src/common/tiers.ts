// Tier constants shared across modules (mirrors PRD §3).
export type Tier = "TIER I" | "TIER II" | "TIER III";

export const TIER_MIN: Record<Tier, number> = {
  "TIER I": 100_000,
  "TIER II": 500_000,
  "TIER III": 1_000_000,
};

export function tierOf(v: number): Tier | null {
  if (v >= 1_000_000) return "TIER III";
  if (v >= 500_000) return "TIER II";
  if (v >= 100_000) return "TIER I";
  return null;
}

export function tierRank(t: string | null | undefined): number {
  if (t === "TIER III") return 3;
  if (t === "TIER II") return 2;
  if (t === "TIER I") return 1;
  return 0;
}

export const VIS_MODES = ["HIDDEN", "CATEGORIES", "FULL"] as const;
export const CHAINS = ["EVM", "SOL", "BTC"] as const;

export function shortAddr(a: string): string {
  return a.length > 18 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
}
