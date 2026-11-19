/** A tab-scoped, opaque handle. The Bailian session ID never reaches the browser. */
const STORAGE_KEY = "travelworld:agent-visit:v1";
const CHANNEL_NAME = "travelworld:agent-visit-ownership:v1";
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBE_WAIT_MS = 180;

type VisitMessage = {
  type: "probe" | "occupied";
  token: string;
  instanceId: string;
  targetId?: string;
};

let memoryToken: string | null = null;
let activeToken: string | null = null;
let pending: Promise<string> | null = null;
let channel: BroadcastChannel | null = null;
let probingToken: string | null = null;
let occupied = false;
let instanceId: string | null = null;

function browserInstanceId(): string {
  // Client modules can also be evaluated while rendering HTML on the server.
  // Generate this only after getTravelVisitToken has confirmed a browser.
  return (instanceId ??= crypto.randomUUID());
}

function saveToken(token: string): void {
  memoryToken = token;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Private browsing may deny storage; memory still scopes the visit
    // to this mounted page and a later reload starts a fresh visit.
  }
}

function storedToken(): string {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored && TOKEN_PATTERN.test(stored)) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    // Use memory below.
  }
  const token = memoryToken ?? crypto.randomUUID();
  saveToken(token);
  return token;
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const id = browserInstanceId();
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<VisitMessage>) => {
      const message = event.data;
      if (!message || message.instanceId === id || !TOKEN_PATTERN.test(message.token)) return;
      if (message.type === "probe" && activeToken === message.token) {
        channel?.postMessage({
          type: "occupied",
          token: message.token,
          instanceId: id,
          targetId: message.instanceId,
        } satisfies VisitMessage);
      }
      if (
        message.type === "occupied" &&
        message.targetId === id &&
        probingToken === message.token
      ) {
        occupied = true;
      }
    };
    return channel;
  } catch {
    return null;
  }
}

function isReloadNavigation(): boolean {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return navigation?.type === "reload";
}

/**
 * sessionStorage survives refresh and same-tab navigation, but browsers may
 * copy it when a tab is duplicated. An existing tab answers a short ownership
 * probe so the new tab rotates the copied token before its first API request.
 */
export function getTravelVisitToken(): Promise<string> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Travel visit tokens are browser-only."));
  }
  if (pending) return pending;
  pending = (async () => {
    const token = storedToken();
    activeToken = token;
    const bus = ensureChannel();
    if (!bus) return token;

    // During a reload the outgoing document can briefly answer the ownership
    // probe before it closes its channel. It is the same tab, so retain the
    // visit token; copied tabs still use the probe below to rotate theirs.
    if (isReloadNavigation()) return token;

    occupied = false;
    probingToken = token;
    bus.postMessage({ type: "probe", token, instanceId: browserInstanceId() } satisfies VisitMessage);
    await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS));
    probingToken = null;
    if (!occupied) return token;

    const replacement = crypto.randomUUID();
    saveToken(replacement);
    activeToken = replacement;
    return replacement;
  })();
  return pending;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    channel?.close();
    channel = null;
  });
  window.addEventListener("pageshow", () => {
    // A page restored from the back-forward cache keeps module state but needs
    // to answer new tabs' probes again.
    if (activeToken) ensureChannel();
  });
}
