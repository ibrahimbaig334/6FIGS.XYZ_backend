-- Remove the devnet mock-balance hook. Tiers come only from TEE attestations now.
ALTER TABLE "Wallet" DROP COLUMN "mockUsd";
