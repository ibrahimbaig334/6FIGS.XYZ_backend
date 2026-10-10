-- Token-gated rooms (minToken) + configurable room size (maxMembers).
ALTER TABLE "Room" ADD COLUMN "minToken" TEXT;
ALTER TABLE "Room" ADD COLUMN "maxMembers" INTEGER NOT NULL DEFAULT 2;
