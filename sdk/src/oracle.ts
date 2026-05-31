// Pyth PriceUpdateV2 reader (client side) — mirrors programs/.../src/pyth.rs.
// Decodes the raw account bytes and normalizes the price to the protocol's
// internal fixed-point: USD * 1e6 (== USDC base units per SOL, since USDC has 6
// decimals and 1 lot = 1 SOL). Pyth reports `mantissa * 10^exponent = USD`, so
// internal = mantissa * 10^(exponent + 6). Real devnet SOL/USD is exponent -8
// (=> divide by 100); the localnet mock writes exponent -6 (=> x1, mantissa is
// already USD*1e6); the synthetic test fixture is exponent -8.
//
// Used by the app (live index) and the keeper (liquidation PnL) so both agree
// with the on-chain reader byte-for-byte. Returns null on a missing/short/
// non-positive feed rather than throwing, so pollers degrade gracefully.

const INTERNAL_PRICE_DECIMALS = 6;

// 10^n as a bigint (n >= 0).
function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

// Parse + normalize a PriceUpdateV2 account's data. Layout after the 8-byte
// discriminator: write_authority(32), verification_level(1 byte @ 40: 1=Full,
// 0=Partial which carries an extra num_signatures byte), feed_id(32), price(i64),
// conf(u64), exponent(i32). Full shifts the message to offset 41; Partial to 42.
export function readNormalizedPythPrice(
  data: Uint8Array | null | undefined,
): bigint | null {
  if (!data || data.length < 93) return null;

  // Full(1) => message at 41; anything else (Partial) carries +1 byte => 42.
  const msgOffset = data[40] === 1 ? 41 : 42;
  const priceOffset = msgOffset + 32; // skip feed_id(32)
  const exponentOffset = priceOffset + 8 + 8; // skip price(i64) + conf(u64)
  if (data.length < exponentOffset + 4) return null;

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mantissa = dv.getBigInt64(priceOffset, true);
  if (mantissa <= 0n) return null;
  const exponent = dv.getInt32(exponentOffset, true);

  const shift = exponent + INTERNAL_PRICE_DECIMALS;
  const normalized =
    shift >= 0 ? mantissa * pow10(shift) : mantissa / pow10(-shift);
  return normalized > 0n ? normalized : null;
}
