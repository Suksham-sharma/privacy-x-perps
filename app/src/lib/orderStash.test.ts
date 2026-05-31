// Regression test for the "second order overwrites the first" bug — orderStash
// now keys per maxMargin instead of a single "last order" key.
// Run: pnpm --filter @confidential-perps/app exec tsx --test src/lib/orderStash.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stashOrder, getStashedOrder } from "./orderStash";

// In-memory sessionStorage shim — safe to set here since orderStash reads the
// global only inside its functions, before any test() callback runs.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = new MemStorage();

test("two orders at different margins keep distinct leverage/side/size", () => {
  const a = 16_540000n; // first order: 5x
  const b = 27_570000n; // second order: 3x
  stashOrder(a, { side: 0, size: "1", leverage: 5, clientNonce: "1", privateKey: [1] });
  stashOrder(b, { side: 1, size: "2", leverage: 3, clientNonce: "2", privateKey: [2] });

  // The bug: the second stash overwrote the first, so both rows read leverage 3.
  assert.equal(getStashedOrder(a)?.leverage, 5, "first order keeps its own leverage");
  assert.equal(getStashedOrder(b)?.leverage, 3, "second order keeps its own leverage");
  assert.equal(getStashedOrder(a)?.side, 0);
  assert.equal(getStashedOrder(b)?.side, 1);
  assert.equal(getStashedOrder(a)?.size, "1");
  assert.equal(getStashedOrder(b)?.size, "2");
});

test("unknown margin returns null (row stays sealed)", () => {
  assert.equal(getStashedOrder(99_999999n), null);
});

test("same maxMargin overwrites (documented collision)", () => {
  const m = 41_390000n;
  stashOrder(m, { side: 0, size: "1", leverage: 2, clientNonce: "3", privateKey: [3] });
  stashOrder(m, { side: 0, size: "1", leverage: 4, clientNonce: "4", privateKey: [4] });
  assert.equal(getStashedOrder(m)?.leverage, 4);
});
