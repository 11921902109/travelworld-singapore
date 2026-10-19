export type TravelMode = "walk" | "transit" | "taxi" | "drive" | "bicycle";

export type TravelCommercePrice = {
  amount: number;
  currency: "CNY";
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

export type TripStop = {
  id: string;
  name: string;
  area: string;
  time: string;
  endTime: string;
  duration: string;
  kind: "hotel" | "sight" | "food" | "buffer";
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
};

export type RouteLeg = {
  from: string;
  to: string;
  mode: TravelMode;
  minutes: number;
  distance: string;
  distanceMeters?: number;
  durationSeconds?: number;
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
  missingInformation: string[];
  ambiguities: string[];
  blockingIssues: string[];
  nextQuestion: string | null;
  complete: boolean;
  progress: number;
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
