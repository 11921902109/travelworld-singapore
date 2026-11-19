export type StaySegmentConfig = {
  startDay: number;
  area: string;
  budgetPerNight?: { amount: number; currency: "SGD" | "CNY" } | null;
};

type SavedStaySegment = StaySegmentConfig & {
  id: string;
  checkInDate: string;
  checkOutDate: string;
  hotel?: unknown;
  hotelCandidates?: unknown[];
  budgetReviewRequired?: boolean;
};

export function normalizeStayArea(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-SG");
}

export function staySegmentConfigKey(segments: StaySegmentConfig[]): string {
  return JSON.stringify(segments.map((segment) => ({
    startDay: segment.startDay,
    area: normalizeStayArea(segment.area),
    budget: segment.budgetPerNight
      ? { amount: segment.budgetPerNight.amount, currency: segment.budgetPerNight.currency }
      : null,
  })));
}

function sameBudget(a: StaySegmentConfig, b: StaySegmentConfig): boolean {
  return (a.budgetPerNight?.amount ?? null) === (b.budgetPerNight?.amount ?? null) &&
    (a.budgetPerNight?.currency ?? null) === (b.budgetPerNight?.currency ?? null);
}

/** Re-saving unchanged dates/areas never discards verified hotels or quotes. */
export function reconcileStaySegments<T extends SavedStaySegment>(previous: T[], next: T[]): {
  segments: T[];
  unchanged: boolean;
  timingChanged: boolean;
  changedFields: string[];
  invalidatedHotelSegments: number[];
  budgetReviewSegments: number[];
} {
  const unchanged = previous.length === next.length && next.every((segment, index) => {
    const old = previous[index];
    return old && old.startDay === segment.startDay && normalizeStayArea(old.area) === normalizeStayArea(segment.area) &&
      old.checkInDate === segment.checkInDate && old.checkOutDate === segment.checkOutDate && sameBudget(old, segment);
  });
  if (unchanged) return { segments: previous, unchanged: true, timingChanged: false,
    changedFields: [], invalidatedHotelSegments: [], budgetReviewSegments: [] };

  const changedFields: string[] = [];
  const invalidated = new Set<number>();
  const budgetReviewSegments: number[] = [];
  let timingChanged = previous.length !== next.length;
  if (previous.length !== next.length) changedFields.push("住宿段数");
  const retainedOldIds = new Set<string>();
  const segments = next.map((segment, index) => {
    const old = previous.find((item) => item.startDay === segment.startDay);
    const compatible = old && normalizeStayArea(old.area) === normalizeStayArea(segment.area) &&
      old.checkInDate === segment.checkInDate && old.checkOutDate === segment.checkOutDate;
    if (compatible) {
      retainedOldIds.add(old.id);
      const budgetChanged = !sameBudget(old, segment);
      if (budgetChanged) {
        changedFields.push(`第 ${index + 1} 段预算`);
        if (old.hotel || old.hotelCandidates?.length) budgetReviewSegments.push(segment.startDay);
      }
      return { ...old, ...segment, id: old.id,
        ...(budgetChanged && (old.hotel || old.hotelCandidates?.length) ? { budgetReviewRequired: true } : {}) };
    }
    timingChanged = true;
    changedFields.push(`第 ${index + 1} 段区域或入住日期`);
    if (old?.hotel || old?.hotelCandidates?.length) invalidated.add(old.startDay);
    // The newly dated segment is authoritative. A hotel selected for old dates
    // must not silently travel across a changed night boundary.
    const { hotel: _hotel, hotelCandidates: _candidates, budgetReviewRequired: _review, ...clean } = segment;
    void _hotel; void _candidates; void _review;
    return clean as T;
  });
  for (const old of previous) {
    if (!retainedOldIds.has(old.id) && (old.hotel || old.hotelCandidates?.length)) invalidated.add(old.startDay);
  }
  return { segments, unchanged: false, timingChanged, changedFields,
    invalidatedHotelSegments: [...invalidated].sort((a, b) => a - b), budgetReviewSegments };
}
