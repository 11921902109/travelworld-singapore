export type FlightLocation = { input: string; name: string; kind: "city" | "airport" | "unspecified"; normalized: boolean };

// Known aliases only. Unknown names remain unchanged for the tool's own
// documented location resolver; no airport code or wider search is invented.
const locations: Array<{ name: string; kind: "city" | "airport"; aliases: string[] }> = [
  { name: "新加坡", kind: "city", aliases: ["Singapore", "新加坡", "新加坡市"] },
  { name: "温州", kind: "city", aliases: ["温州", "温州市", "Wenzhou"] },
  { name: "北京", kind: "city", aliases: ["北京", "北京市", "Beijing"] },
  { name: "上海", kind: "city", aliases: ["上海", "上海市", "Shanghai"] },
  { name: "新加坡樟宜机场", kind: "airport", aliases: ["新加坡樟宜机场", "新加坡樟宜国际机场", "樟宜机场", "Singapore Changi Airport", "Changi Airport"] },
  { name: "温州龙湾国际机场", kind: "airport", aliases: ["温州机场", "温州龙湾机场", "温州龙湾国际机场", "Wenzhou Longwan International Airport", "Wenzhou Longwan Airport"] },
  { name: "北京首都国际机场", kind: "airport", aliases: ["北京首都机场", "北京首都国际机场", "Beijing Capital International Airport"] },
  { name: "北京大兴国际机场", kind: "airport", aliases: ["北京大兴机场", "北京大兴国际机场", "Beijing Daxing International Airport"] },
  { name: "上海浦东国际机场", kind: "airport", aliases: ["上海浦东机场", "上海浦东国际机场", "Shanghai Pudong International Airport"] },
];
const key = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function normalizeFlightLocation(value: string): FlightLocation {
  const input = value.trim().slice(0, 100);
  const match = locations.find((item) => item.aliases.some((alias) => key(alias) === key(input)));
  return match ? { input, name: match.name, kind: match.kind, normalized: input !== match.name }
    : { input, name: input, kind: "unspecified", normalized: false };
}
