import assert from "node:assert/strict";
import { test } from "node:test";

const storageKey = "travelworld:agent-visit:v1";
const originalToken = "a2af00e1-05b7-4f9e-a599-5564eedbab60";

async function tokenWithNavigation(type) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
  const previousBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
  const stored = new Map([[storageKey, originalToken]]);

  class OccupiedChannel {
    onmessage = null;
    postMessage(message) {
      if (message.type !== "probe") return;
      queueMicrotask(() => this.onmessage?.({ data: {
        type: "occupied", token: message.token,
        instanceId: "other-live-document", targetId: message.instanceId,
      } }));
    }
    close() {}
  }

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => stored.set(key, value),
        },
        addEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { getEntriesByType: () => [{ type }] },
    });
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true, value: OccupiedChannel,
    });
    const visitClient = await import(`../lib/travel/visit-client.ts?navigation=${type}`);
    return { token: await visitClient.getTravelVisitToken(), stored: stored.get(storageKey) };
  } finally {
    for (const [name, descriptor] of [
      ["window", previousWindow],
      ["performance", previousPerformance],
      ["BroadcastChannel", previousBroadcastChannel],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("刷新保留同一访问标识，即使旧页面短暂仍响应占用探测", async () => {
  const result = await tokenWithNavigation("reload");
  assert.equal(result.token, originalToken);
  assert.equal(result.stored, originalToken);
});

test("复制页面得到独立访问标识", async () => {
  const result = await tokenWithNavigation("navigate");
  assert.notEqual(result.token, originalToken);
  assert.equal(result.stored, result.token);
});
