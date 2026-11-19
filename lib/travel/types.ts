export type TravelMode = "walk" | "transit" | "taxi" | "drive" | "bicycle";

export type TravelCommercePrice = {
  amount: number;
  // Preserve supplier currency for verification; display code only shows genuine CNY prices.
  currency: string;
  display: string;
  unit?: string;
};

export type TravelCommerce = {
  provider: "fliggy";
  kind: "hotel" | "poi";
  status: "available" | "unavailable" | "needs_details";
  price?: TravelCommercePrice;
  bookingUrl?: string;
  matchedName?: string;
  note?: string;
  updatedAt?: string;
};

export type TripCommerceSummary = {
  provider: "fliggy";
  status: "available" | "unavailable" | "needs_details";
  note?: string;
  updatedAt?: string;
};

export type HotelStopQuote = {
  checkInDate: string;
  checkOutDate: string;
  status: "available" | "not_requested" | "unavailable" | "failed";
};

export type TripStop = {
  id: string;
  name: string;
  area: string;
  time: string;
  endTime: string;
  duration: string;
  kind: "hotel" | "sight" | "food" | "other" | "buffer";
  sceneRole?: "culinary_area" | "restaurant_meal" | "attraction";
  includedMealMinutes?: number;
  durationReason?: string;
  aiAdvice?: { pros: string; cons: string };
  x: number;
  y: number;
  verified: boolean;
  note: string;
  categoryLabel?: string;
  description?: string;
  warning?: string;
  placeId?: string;
  lat?: number;
  lng?: number;
  address?: string;
  types?: string[];
  primaryType?: string | null;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string | null;
  openingHours?: string[];
  openingHoursInfo?: {
    openNow: boolean | null;
    weekdayDescriptions: string[];
    nextOpenTime: string | null;
    nextCloseTime: string | null;
  } | null;
  location?: { lat: number; lng: number };
  commerce?: TravelCommerce;
  hotelQuote?: HotelStopQuote;
};

export type RouteLeg = {
  from: string;
  to: string;
  mode: TravelMode;
  minutes: number;
  distance: string;
  distanceMeters?: number;
  durationSeconds?: number;
  /** Estimated pickup/wait time added by Travelworld, not by Google Routes. */
  pickupMinutes?: number;
  /** Geometry may remain Google-sourced while the user sets the daily travel total. */
  timeSource?: "google" | "user";
  referenceMinutes?: number;
  encodedPolyline?: string;
  verified?: boolean;
  provider?: "google" | "demo";
};

export type TripDay = {
  id: string;
  label: string;
  date: string;
  weekday: string;
  theme: string;
  color: string;
  summary: string;
  returnBy?: string;
  /** The daily deadline applies to this endpoint; an airport is not a hotel return. */
  terminalKind?: "hotel" | "airport";
  /** A traveller explicitly accepted this hotel return deadline overrun. */
  overtimeAcceptance?: {
    minutes: number;
    acceptedAt: string;
    deadline: string;
    estimatedArrival: string;
  };
  stops: TripStop[];
  legs: RouteLeg[];
};

/**
 * The one accommodation location a live Singapore trip is anchored to.
 * This is deliberately separate from a timeline hotel stop: it is selected
 * by the traveller and re-validated by Google Places before routing.
 */
export type ConfirmedAccommodationAnchor = {
  placeId: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  googleMapsUri?: string | null;
  kind: "hotel";
  source: "google_places";
  userConfirmed: true;
};

/**
 * A confirmed hotel takes effect from one itinerary day until the next
 * segment begins. On a segment's first day the route starts at the previous
 * night's hotel and ends at this hotel, making the hotel move explicit.
 */
export type AccommodationSegment = {
  id: string;
  startDayId: string;
  anchor: ConfirmedAccommodationAnchor;
};

/** The airport journey for a flight leaving the day after the itinerary ends. */
export type NextDayDepartureTransfer = {
  /** Calendar date on which the flight departs, in Singapore local time. */
  date: string;
  departureAt: string;
  leaveHotelAt: string;
  arriveAirportAt: string;
  airportCutoffAt: string;
  airportLeadMinutes: number;
  fromHotel: ConfirmedAccommodationAnchor;
  toAirport: {
    placeId: string;
    name: string;
    address: string;
    location: { lat: number; lng: number };
    googleMapsUri?: string | null;
  };
  leg: RouteLeg;
  note: string;
};

export type DemoTrip = {
  id: string;
  title: string;
  destination: string;
  dateRange: string;
  timezone: string;
  hotel: string;
  accommodationMode?: "hotel" | "area";
  accommodationAnchor?: ConfirmedAccommodationAnchor;
  accommodationSegments?: AccommodationSegment[];
  /** Separate from the 1–7 itinerary days; may begin on the previous evening. */
  departureTransfer?: NextDayDepartureTransfer;
  pace: string;
  people: number;
  days: TripDay[];
  source?: "demo" | "live";
  generatedAt?: string;
  warnings?: string[];
  commerce?: TripCommerceSummary;
};

export type SingaporeTravelIntent = {
  destination?: "Singapore";
  durationDays?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  originCity?: string | null;
  travelers?: {
    total?: number | null;
    adults?: number | null;
    children?: number | null;
    seniors?: number | null;
  };
  accommodation?: {
    hotelName?: string | null;
    areaName?: string | null;
    googlePlaceId?: string | null;
  };
  dailyStartTime?: string | null;
  dailyEndTime?: string | null;
  preferredReturnTime?: string | null;
  latestReturnTime?: string | null;
  pace?: "relaxed" | "balanced" | "packed" | string | null;
  budget?: "budget" | "moderate" | "premium" | string | null;
  budgetDetails?: {
    amount?: number | null;
    currency?: string | null;
    scope?: "per_person_per_day" | "group_per_day" | "per_person_total" | "group_total" | null;
    excludesFlights?: boolean | null;
  };
  interests?: string[];
  mustVisit?: string[];
  allowAutomaticRecommendations?: boolean;
  avoid?: string[];
  mobilityConstraints?: string[];
  dietaryPreferences?: string[];
  dietaryScope?: "all" | "individual" | null;
  noAdditionalDietaryRestrictions?: boolean;
  preferredTransport?: string[];
};

export type SingaporeOutlineDay = {
  day: number;
  theme: string;
  areas: string[];
  experiences: string[];
  summary: string;
};

export type SingaporeIntentResponse = {
  intent: SingaporeTravelIntent;
  outline: SingaporeOutlineDay[];
  acceptedChanges?: Array<{ field: string; op: string; evidenceText: string }>;
  pendingCandidates?: Array<{ field: string; value: unknown; evidenceText: string }>;
  issues?: Array<{
    issueId: string;
    code: string;
    kind: "blocking" | "ambiguity" | "missing";
    field: string | null;
    message: string;
    suggestedQuestion: string | null;
  }>;
  primaryIssueId?: string | null;
  missingInformation: string[];
  ambiguities: string[];
  blockingIssues: string[];
  nextQuestion: string | null;
  complete: boolean;
  progress: number;
  readiness?: { complete: boolean; completeness: number };
  reply: string;
};

export type SingaporePlanResponse = {
  trip: DemoTrip;
  meta: {
    provider: "google";
    status: "candidate";
    generatedAt: string;
    attribution: string;
    warnings: string[];
    sourceQueries: string[];
    assumptions?: string[];
    commerce?: TripCommerceSummary;
  };
};

export type SingaporeRevisionResponse = {
  trip: DemoTrip;
  changedDayId: string;
  selectedStopId?: string;
  reply: string;
};
