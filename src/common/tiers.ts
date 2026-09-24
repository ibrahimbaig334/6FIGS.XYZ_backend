// Tier thresholds are environment-aware (PRD §3):
// prod = I > $100K · II > $500K · III > $1M; devnet uses very low tiers
// because Sepolia-ETH / devnet-SOL faucet amounts are tiny.
export type Tier = "TIER I" | "TIER II" | "TIER III";

export function isDevnet(): boolean {
  return (process.env.CHAIN_MODE ?? "devnet") === "devnet";
}

export function tierThresholds(): Record<Tier, number> {
  if (isDevnet()) return { "TIER I": 10, "TIER II": 100, "TIER III": 1_000 };
  return { "TIER I": 100_000, "TIER II": 500_000, "TIER III": 1_000_000 };
}

export function tierList(): { name: Tier; min: number }[] {
  const t = tierThresholds();
  return [
    { name: "TIER I", min: t["TIER I"] },
    { name: "TIER II", min: t["TIER II"] },
    { name: "TIER III", min: t["TIER III"] },
  ];
}

export function tierOf(v: number): Tier | null {
  const t = tierThresholds();
  if (v >= t["TIER III"]) return "TIER III";
  if (v >= t["TIER II"]) return "TIER II";
  if (v >= t["TIER I"]) return "TIER I";
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
