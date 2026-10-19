import { notFound } from "next/navigation";
import { TripWorkspaceClient } from "./trip-workspace-client";
import { GeneratedTripLoader } from "./generated-trip-loader";
import { demoTrip } from "@/lib/travel/demo-trip";

export default async function TravelTripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  if (tripId === demoTrip.id) return <TripWorkspaceClient trip={{ ...demoTrip, source: "demo" }} />;
  if (!/^singapore-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]{4,32}$/.test(tripId)) notFound();
  return <GeneratedTripLoader tripId={tripId} />;
}
