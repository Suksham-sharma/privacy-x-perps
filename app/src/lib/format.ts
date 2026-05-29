// Shared USDC formatting. USDC is 6 decimals; on-chain amounts are base units
// (bigint). Lot-ticks are treated 1:1 with USDC base units (the v0 unit
// convention locked in the program), so notional = price * size is already in
// base units.
export const USDC_DECIMALS = 6n;
export const USDC = 1_000_000n;

// Localnet index/mark price = the Pyth fixture (100,000 ticks). Phase 5 sources
// this live; for now both the order ticket and PnL use it as the mark.
export const INDEX_PRICE_TICKS = 100_000n;

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
