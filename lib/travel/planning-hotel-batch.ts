import type { HotelQuoteJob } from "./planning-hotel-jobs";

type BatchSegment = {
  startDay: number;
  hotelSearchId?: string;
  hotelCandidates?: Array<{ placeId: string; quoteStatus?: string; quoteJobId?: string }>;
};

/** A completed old task must never describe a newly found candidate batch. */
export function hotelQuoteJobMatchesSegment(job: HotelQuoteJob | undefined, segment: BatchSegment): boolean {
  if (!job || job.startDay !== segment.startDay) return false;
  if (segment.hotelSearchId || job.searchId) return Boolean(segment.hotelSearchId && segment.hotelSearchId === job.searchId);
  const candidates = segment.hotelCandidates || [];
  if (!job.placeIds.length || !job.placeIds.every((id) => candidates.some((hotel) => hotel.placeId === id))) return false;
  // v25 tasks have no searchId. Completed results are visible only when their
  // candidate records prove they were actually merged into this batch.
  return job.status !== "completed" || job.placeIds.every((id) => candidates.some((hotel) => hotel.placeId === id && hotel.quoteJobId === job.id));
}

export function hotelBatchWaiting(job?: HotelQuoteJob): boolean {
  return Boolean(job && job.kind !== "discovery" && ["queued", "running", "timed_out"].includes(job.status));
}
