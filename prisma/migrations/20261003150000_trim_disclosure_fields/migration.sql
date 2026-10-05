-- AlterTable: stablecoin share leaves the signed result and storage
ALTER TABLE "TeeIdentity" DROP COLUMN "stableBps";

-- AlterTable: legacy per-chain allocation percentages leave the cache
ALTER TABLE "EligibilityCache" DROP COLUMN "assetPct";