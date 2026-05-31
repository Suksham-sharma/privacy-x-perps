// Client-side, session-scoped stash of plaintext metadata for orders YOU placed
// (the chain only exposes {owner, maxMargin}), keyed PER ORDER by maxMargin so a
// second order can't overwrite the first. Collision: two orders with identical
// maxMargin share an entry (rare, only loses display fidelity).
const KEY = "iceberg.orders";

export interface OrderStash {
  side: 0 | 1;
  size: string;
  leverage: number;
  clientNonce: string;
  privateKey: number[];
}

type StashMap = Record<string, OrderStash>;

function readMap(): StashMap {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StashMap) : {};
  } catch {
    return {};
  }
}

// Stash an order keyed by its on-chain maxMargin (USDC base units, as a string).
export function stashOrder(maxMargin: bigint, order: OrderStash): void {
  try {
    const map = readMap();
    map[maxMargin.toString()] = order;
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {}
}

// Recover the plaintext metadata for an on-chain slot by its maxMargin, or null
// if this tab never submitted a matching order (then the row stays "sealed").
export function getStashedOrder(maxMargin: bigint): OrderStash | null {
  return readMap()[maxMargin.toString()] ?? null;
}
