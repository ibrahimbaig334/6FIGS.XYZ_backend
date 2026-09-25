-- Matchmaking: match origin, queue tickets, friendships, room requests
ALTER TABLE "Match" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'challenge';

CREATE TABLE "QueueTicket" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Friendship" (
  "aUserId" TEXT NOT NULL,
  "bUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Friendship_pkey" PRIMARY KEY ("aUserId", "bUserId")
);

CREATE TABLE "RoomRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "fromUserId" TEXT NOT NULL,
  "toUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "roomId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "RoomRequest_toUserId_status_idx" ON "RoomRequest"("toUserId", "status");
CREATE INDEX "RoomRequest_fromUserId_status_idx" ON "RoomRequest"("fromUserId", "status");
