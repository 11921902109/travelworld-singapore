import type { SharedTripSnapshot } from "./shared-trip";
import type { DemoTrip } from "./types";

type Point = { lat: number; lng: number };
type MapPlace = {
  id: string;
  position: Point;
  address?: string;
  openingHours?: string[];
  googleMapsUri?: string | null;
};
export type SharedMapData = { places: MapPlace[]; segments: Point[][] };

export function decodeTravelPolyline(encoded: string): Point[] {
  const points: Point[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  function readDelta() {
    let value = 0;
    for (let shift = 0; index < encoded.length && shift <= 30; shift += 5) {
      const digit = encoded.charCodeAt(index++) - 63;
      if (digit < 0 || digit > 63) break;
      value += (digit & 31) * 2 ** shift;
      if (digit < 32) return value % 2 ? -Math.floor(value / 2) - 1 : value / 2;
    }
    return null;
  }
  while (index < encoded.length) {
    const latDelta = readDelta();
    const lngDelta = readDelta();
    if (latDelta === null || lngDelta === null) return [];
    lat += latDelta;
    lng += lngDelta;
    if (Math.abs(lat) > 90e5 || Math.abs(lng) > 180e5) return [];
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** The preview can render already-loaded map data only for items in the server projection. */
export function sharedPreviewMap(snapshot: SharedTripSnapshot, trip: DemoTrip, index: number): SharedMapData {
  const day = snapshot.days[index];
  const original = trip.days[index];
  if (!day || !original) return { places: [], segments: [] };
  const sourceByPublicId = new Map(day.stops.map((stop, i) => [stop.id, original.stops[i]]));
  const places = day.stops.flatMap((stop) => {
    if (!stop.placeId && !stop.location) return [];
    const originalStop = sourceByPublicId.get(stop.id);
    const source = stop.placeId && stop.placeId === originalStop?.placeId ? originalStop : undefined;
    const position = stop.location || (source?.location ?? (source?.lat != null && source.lng != null ? { lat: source.lat, lng: source.lng } : null));
    if (!position) return [];
    return [{ id: stop.id, position, address: source?.address, openingHours: source?.openingHours, googleMapsUri: source?.googleMapsUri }];
  });
  const segments = day.legs.flatMap(({ from, to }) => {
    const originalFrom = sourceByPublicId.get(from)?.id;
    const originalTo = sourceByPublicId.get(to)?.id;
    const line = original.legs.find((item) => item.from === originalFrom && item.to === originalTo)?.encodedPolyline;
    return line ? [decodeTravelPolyline(line)] : [];
  });
  const transfer = index === snapshot.days.length - 1 ? snapshot.departureTransfer : undefined;
  if (transfer && trip.departureTransfer) {
    const { fromHotel, toAirport, leg } = trip.departureTransfer;
    for (const [stop, source] of [[transfer.fromHotel, fromHotel], [transfer.toAirport, toAirport]] as const) {
      if (stop.placeId && source.placeId === stop.placeId) {
        places.push({ id: stop.id, position: source.location, address: source.address, googleMapsUri: source.googleMapsUri, openingHours: undefined });
      }
    }
    if (transfer.leg && leg.encodedPolyline) segments.push(decodeTravelPolyline(leg.encodedPolyline));
  }
  return { places, segments };
}
