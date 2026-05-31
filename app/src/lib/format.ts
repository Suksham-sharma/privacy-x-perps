// Shared USDC formatting. USDC is 6 decimals; on-chain amounts are base units
// (bigint). Lot-ticks are treated 1:1 with USDC base units (the v0 unit
// convention locked in the program), so notional = price * size is already in
// base units.
export const USDC_DECIMALS = 6n;
export const USDC = 1_000_000n;

// NOTE: the index/mark price is now LIVE — read from the on-chain mock oracle
// via useIndexPrice() (USD * 1e6 == USDC base units per SOL, 1 lot = 1 SOL).
// The old hardcoded INDEX_PRICE_TICKS constant was removed.

export function fmtUsdc(base: bigint | undefined): string {
  if (base === undefined) return "—";
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / USDC;
  const cents = (abs % USDC) / 10_000n;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${cents
    .toString()
    .padStart(2, "0")}`;
}
