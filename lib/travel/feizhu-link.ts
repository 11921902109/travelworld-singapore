const trustedHost = /(^|\.)(?:feizhu\.com|fliggy\.com|alitrip\.com|taobao\.com|tmall\.com)$/i;
const redirectKeys = new Set(["url", "redirect", "redirecturl", "redirect_url", "redirect_uri", "target", "targeturl", "target_url", "returnurl", "return_url"]);

/** Accept only returned HTTPS supplier links, including bounded trusted wrappers. */
export function normalizeFeizhuBookingUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2400 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const markdown = /^\[(https:\/\/[^\]\s]+)\]\((https:\/\/[^)\s]+)\)$/.exec(raw);
  const candidate = markdown && markdown[1] === markdown[2] ? markdown[1] : raw;
  function inspect(input: string, depth: number, base?: URL): URL | null {
    if (depth > 4 || input.length > 2400) return null;
    try {
      let decoded = input;
      // Decode an encoded scheme/authority only; an already parsed HTTPS URL
      // keeps its own encoded query delimiters intact for recursive inspection.
      for (let attempt = 0; attempt < 3 && !/^[a-z][a-z0-9+.-]*:/i.test(decoded) && /%[0-9a-f]{2}/i.test(decoded.split(/[/?#]/, 1)[0]); attempt++) decoded = decodeURIComponent(decoded);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(decoded) && /%[0-9a-f]{2}/i.test(decoded.split(/[/?#]/, 1)[0])) return null;
      const url = base ? new URL(decoded, base) : new URL(decoded);
      if (url.protocol !== "https:" || !trustedHost.test(url.hostname) || url.username || url.password) return null;
      const hashQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : url.hash.replace(/^#/, "");
      for (const params of [url.searchParams, new URLSearchParams(hashQuery)]) {
        for (const [key, target] of params) {
          if (redirectKeys.has(key.toLowerCase()) && target && !inspect(target, depth + 1, url)) return null;
        }
      }
      return url;
    } catch { return null; }
  }
  return inspect(candidate, 0)?.toString() || null;
}

export function firstFeizhuBookingUrl(...values: unknown[]): string | null {
  for (const value of values) { const url = normalizeFeizhuBookingUrl(value); if (url) return url; }
  return null;
}
