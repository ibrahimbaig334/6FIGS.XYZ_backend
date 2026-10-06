-- Re-key TeeIdentity by userId so the email account is stable across wallet
-- set changes; identityNullifier becomes a unique derived commitment. The FK
-- from TeeWalletBinding is re-added after the unique index exists, because
-- Postgres refuses to drop a primary key an FK depends on.

-- DropForeignKey
ALTER TABLE "TeeWalletBinding" DROP CONSTRAINT "TeeWalletBinding_identityNullifier_fkey";

-- DropIndex
DROP INDEX "TeeIdentity_userId_key";

-- AlterTable
ALTER TABLE "TeeIdentity" DROP CONSTRAINT "TeeIdentity_pkey",
ADD CONSTRAINT "TeeIdentity_pkey" PRIMARY KEY ("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TeeIdentity_identityNullifier_key" ON "TeeIdentity"("identityNullifier");

-- AddForeignKey
ALTER TABLE "TeeWalletBinding" ADD CONSTRAINT "TeeWalletBinding_identityNullifier_fkey" FOREIGN KEY ("identityNullifier") REFERENCES "TeeIdentity"("identityNullifier") ON DELETE CASCADE ON UPDATE CASCADE;
