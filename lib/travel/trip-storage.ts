import type {
  DemoTrip,
  SingaporeOutlineDay,
  SingaporePlanResponse,
  SingaporeTravelIntent,
} from "./types";

export const LIVE_TRIP_STORAGE_PREFIX = "travelworld:live-trip:";

export type StoredLiveTrip = {
  trip: DemoTrip;
  meta: SingaporePlanResponse["meta"];
  intent?: SingaporeTravelIntent;
  outline?: SingaporeOutlineDay[];
  savedAt: string;
};

export function liveTripStorageKey(tripId: string) {
  return `${LIVE_TRIP_STORAGE_PREFIX}${tripId}`;
}
