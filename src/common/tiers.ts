// Tier thresholds are environment-aware (PRD §3):
// mainnet = I > $100K · II > $300K · III > $500K · IV > $1M; devnet uses very
// low tiers because devnet-SOL faucet amounts are tiny.
import { requiredEnv } from "./env";

export type Tier = "TIER I" | "TIER II" | "TIER III" | "TIER IV";

export function isDevnet(): boolean {
  return requiredEnv("CHAIN_MODE") === "devnet";
}

export function tierThresholds(): Record<Tier, number> {
  if (isDevnet())
    return { "TIER I": 10, "TIER II": 100, "TIER III": 500, "TIER IV": 1_000 };
  return {
    "TIER I": 100_000,
    "TIER II": 300_000,
    "TIER III": 500_000,
    "TIER IV": 1_000_000,
  };
}

export function tierList(): { name: Tier; min: number }[] {
  const t = tierThresholds();
  return [
    { name: "TIER I", min: t["TIER I"] },
    { name: "TIER II", min: t["TIER II"] },
    { name: "TIER III", min: t["TIER III"] },
    { name: "TIER IV", min: t["TIER IV"] },
  ];
}

export function tierOf(v: number): Tier | null {
  const t = tierThresholds();
  if (v >= t["TIER IV"]) return "TIER IV";
  if (v >= t["TIER III"]) return "TIER III";
  if (v >= t["TIER II"]) return "TIER II";
  if (v >= t["TIER I"]) return "TIER I";
  return null;
}

export function tierRank(t: string | null | undefined): number {
  if (t === "TIER IV") return 4;
  if (t === "TIER III") return 3;
  if (t === "TIER II") return 2;
  if (t === "TIER I") return 1;
  return 0;
}

export const VIS_MODES = ["HIDDEN", "VISIBLE"] as const;
export const CHAINS = ["SOL"] as const;

export function shortAddr(a: string): string {
  return a.length > 18 ? a.slice(0, 8) + "…" + a.slice(-4) : a;
}
