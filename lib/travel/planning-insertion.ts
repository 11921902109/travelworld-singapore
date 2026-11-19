/** Map an actual timeline anchor, including hotels/airports, to the scene board. */
export function planningBoardInsertionIndex(
  stops: Array<{ id: string; placeId?: string | null }>,
  orderedIds: string[],
  candidates: Array<{ id: string; placeId: string }>,
  anchor: { nodeId: string; placement: "before" | "after" },
) {
  const index = stops.findIndex((stop) => stop.id === anchor.nodeId);
  if (index < 0) return undefined;
  const precedingPlaces = new Set(stops.slice(0, index + (anchor.placement === "after" ? 1 : 0)).map((stop) => stop.placeId));
  return orderedIds.filter((id) => precedingPlaces.has(candidates.find((item) => item.id === id || item.placeId === id)?.placeId || id)).length;
}
