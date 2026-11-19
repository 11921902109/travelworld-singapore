import type { ConfirmedAccommodationAnchor } from "./types";

export type HotelVerifiedPlace = Omit<ConfirmedAccommodationAnchor, "userConfirmed"> & {
  verifiedAt: string;
  contextKey: string;
};

export function hotelIdentityContextKey(handoffId: string, segment: { id: string; area: string; checkInDate: string; checkOutDate: string }): string {
  return JSON.stringify([handoffId, segment.id, segment.area.trim().toLowerCase(), segment.checkInDate, segment.checkOutDate]);
}

/** Current-visit server-authored evidence only. A missing/expired snapshot is re-fetched. */
export function verifiedHotelAnchor(snapshot: HotelVerifiedPlace | undefined, placeId: string, contextKey: string, now = Date.now()): ConfirmedAccommodationAnchor | null {
  if (!snapshot || snapshot.placeId !== placeId || snapshot.contextKey !== contextKey || snapshot.source !== "google_places" || snapshot.kind !== "hotel") return null;
  const timestamp = Date.parse(snapshot.verifiedAt);
  if (!Number.isFinite(timestamp) || timestamp > now + 60_000 || now - timestamp > 15 * 60_000 || !snapshot.name || !snapshot.address) return null;
  const location = snapshot.location;
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng) || location.lat < 1.1496 || location.lat > 1.4784 || location.lng < 103.594 || location.lng > 104.106) return null;
  return { placeId, name: snapshot.name, address: snapshot.address, location, googleMapsUri: snapshot.googleMapsUri,
    kind: "hotel", source: "google_places", userConfirmed: true };
}
