import { NextRequest, NextResponse } from "next/server";
import { guardSingaporeApi } from "@/lib/travel/api-guard";
import { computeSingaporeRoute, getSingaporePlaceDetails } from "@/lib/travel/google-maps";
import { decodeTravelPolyline, type SharedMapData } from "@/lib/travel/shared-map-data";
import { readSharedTrip } from "@/lib/travel/shared-trip-store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest, { params }: { params: Promise<{ shareId: string }> }) {
  const blocked = guardSingaporeApi(request, { bucket: "share-map", limit: 12, windowMs: 60_000 });
  if (blocked) return blocked;

  const { shareId } = await params;
  const trip = await readSharedTrip(shareId);
  const index = Number(request.nextUrl.searchParams.get("day") ?? "0");
  const day = Number.isInteger(index) && index >= 0 ? trip?.snapshot.days[index] : undefined;
  if (!trip || !day) return NextResponse.json({ error: "此分享链接或日期无法打开。" }, { status: 404, headers });

  const transfer = index === trip.snapshot.days.length - 1 ? trip.snapshot.departureTransfer : undefined;
  const stops = transfer ? [...day.stops, transfer.fromHotel, transfer.toAirport] : day.stops;
  const legs = transfer?.leg ? [...day.legs, transfer.leg] : day.legs;
  const result: SharedMapData = { places: [], segments: [] };
  const detailsByPlaceId = new Map<string, ReturnType<typeof getSingaporePlaceDetails>>();
  for (let offset = 0; offset < stops.length; offset += 4) {
    const found = await Promise.all(stops.slice(offset, offset + 4).map(async (stop) => {
      if (stop.location) return { id: stop.id, position: stop.location };
      if (!stop.placeId) return null;
      try {
        const pending = detailsByPlaceId.get(stop.placeId) ?? getSingaporePlaceDetails(stop.placeId);
        detailsByPlaceId.set(stop.placeId, pending);
        const place = await pending;
        return { id: stop.id, position: place.location, address: place.address,
          openingHours: place.openingHours?.weekdayDescriptions, googleMapsUri: place.googleMapsUri };
      } catch {
        return null;
      }
    }));
    result.places.push(...found.filter((place): place is NonNullable<typeof place> => place !== null));
  }

  const positionById = new Map(result.places.map((place) => [place.id, place.position]));
  for (let offset = 0; offset < legs.length; offset += 4) {
    const lines = await Promise.all(legs.slice(offset, offset + 4).map(async (leg) => {
      const origin = positionById.get(leg.from);
      const destination = positionById.get(leg.to);
      if (!origin || !destination) return [];
      try {
        const route = await computeSingaporeRoute({ origin, destination, mode: leg.mode === "taxi" ? "drive" : leg.mode });
        return decodeTravelPolyline(route.encodedPolyline);
      } catch {
        return [];
      }
    }));
    result.segments.push(...lines.filter((line) => line.length >= 2));
  }
  return NextResponse.json(result, { headers });
}
