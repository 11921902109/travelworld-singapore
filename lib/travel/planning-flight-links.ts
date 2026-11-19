import type { FlightLookupLink } from "./planning-flights";
import { normalizeFeizhuBookingUrl } from "./feizhu-link";

// Compare transparent, single-target wrappers without changing the returned URL
// used for navigation. Signed/product query parameters remain significant.
function linkIdentity(url: string): string {
  let current = url;
  for (let depth = 0; depth < 4; depth++) {
    const parsed = new URL(current);
    if (parsed.hostname !== "router.feizhu.com" || parsed.pathname !== "/multi/webview" || parsed.hash ||
        [...parsed.searchParams.keys()].length !== 1 || !parsed.searchParams.has("url")) break;
    const target = normalizeFeizhuBookingUrl(parsed.searchParams.get("url"));
    if (!target) break;
    current = target;
  }
  return current;
}

export function flightSearchLinkGroups(links: FlightLookupLink[] | undefined, direction: "outbound" | "inbound") {
  const groups = new Map<string, FlightLookupLink[]>();
  const seen = new Set<string>();
  for (const link of links || []) {
    if (link.direction !== direction) continue;
    const url = normalizeFeizhuBookingUrl(link.url);
    if (!url) continue;
    const date = link.departureDate || "";
    const identity = `${date}:${linkIdentity(url)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    groups.set(date, [...(groups.get(date) || []), { ...link, url }]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date: date || null, links: items }));
}
