import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { travelSharedTrips } from "@/db/schema";
import { isSharedTripExpired, SharedTripSnapshotSchema } from "@/lib/travel/shared-trip";

export async function readSharedTrip(shareId: string) {
  if (!/^[a-f0-9]{32}$/.test(shareId)) return null;
  const [row] = await getDb().select().from(travelSharedTrips).where(eq(travelSharedTrips.id, shareId)).limit(1);
  if (!row || isSharedTripExpired(row.expiresAt)) return null;
  try {
    const snapshot = SharedTripSnapshotSchema.safeParse(JSON.parse(row.snapshotJson));
    return snapshot.success ? { snapshot: snapshot.data, expiresAt: row.expiresAt } : null;
  } catch {
    return null;
  }
}
