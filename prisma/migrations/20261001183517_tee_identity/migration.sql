-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "TeeIdentity" (
    "identityNullifier" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "tierLabel" TEXT NOT NULL,
    "portfolioBand" TEXT NOT NULL,
    "stableBps" INTEGER NOT NULL,
    "topAssets" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "escrowBlob" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeIdentity_pkey" PRIMARY KEY ("identityNullifier")
);

-- CreateTable
CREATE TABLE "TeeWalletBinding" (
    "walletNullifier" TEXT NOT NULL,
    "identityNullifier" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeeWalletBinding_pkey" PRIMARY KEY ("walletNullifier")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeeIdentity_userId_key" ON "TeeIdentity"("userId");

-- CreateIndex
CREATE INDEX "TeeWalletBinding_identityNullifier_idx" ON "TeeWalletBinding"("identityNullifier");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "TeeIdentity" ADD CONSTRAINT "TeeIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeWalletBinding" ADD CONSTRAINT "TeeWalletBinding_identityNullifier_fkey" FOREIGN KEY ("identityNullifier") REFERENCES "TeeIdentity"("identityNullifier") ON DELETE CASCADE ON UPDATE CASCADE;

