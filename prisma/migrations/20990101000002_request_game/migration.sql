-- Accepted room requests create temporary matches instead of listed rooms
ALTER TABLE "RoomRequest" ADD COLUMN "matchId" TEXT;
ALTER TABLE "RoomRequest" ADD COLUMN "gameId" TEXT;
