// Shared USDC formatting. 6 decimals; amounts are base units (bigint). Lot-ticks
// are 1:1 with USDC base units (v0), so notional = price * size is base units.
export const USDC_DECIMALS = 6n;
export const USDC = 1_000_000n;

// Mark price is LIVE via useIndexPrice() — USD * 1e6 == USDC base units per SOL,
// 1 lot = 1 SOL (the old hardcoded INDEX_PRICE_TICKS was removed).

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
