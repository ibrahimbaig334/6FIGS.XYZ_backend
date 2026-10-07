-- Optional username login + wallet recovery mapping; drops email auth.
ALTER TABLE "User" ADD COLUMN "username" TEXT;
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
ALTER TABLE "User" DROP COLUMN "email";
ALTER TABLE "User" DROP COLUMN "emailVerifiedAt";
DROP TABLE "EmailToken";
CREATE TABLE "WalletRecovery" (
    "addressHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletRecovery_pkey" PRIMARY KEY ("addressHash")
);
CREATE INDEX "WalletRecovery_userId_idx" ON "WalletRecovery"("userId");
ALTER TABLE "WalletRecovery" ADD CONSTRAINT "WalletRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
