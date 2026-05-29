// Build a synthetic Pyth PriceUpdateV2 JSON fixture for localnet tests.
//
// Why synthetic, not cloned-from-devnet:
//   1. Real SOL/USD is ~$200 (mantissa ~20e9 at exp -8), but v0 tests order at
//      price 100_000 — a real Pyth read's ±5% oracle band rejects every order.
//   2. A cloned account's publish_time is frozen, so it goes stale during long
//      runs even with the test-stale-ok 600s window.
// The fixture sidesteps both: price = 100_000 (matches test orders) and
// publish_time = i64::MAX (never stale via saturating_sub in pyth.rs).
//
// Layout mirrors pyth_solana_receiver_sdk::PriceUpdateV2 exactly: the
// receiver-program owner passes the owner check; the discriminator + Full
// verification + feed_id pass the rest of read_pyth_price's gates.
//
// Run from repo root:  node scripts/build-pyth-fixture.mjs
// Output:              tests/fixtures/pyth_sol_usd.json

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const PRICE_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// 8-byte Anchor discriminator for PriceUpdateV2 (= first 8 bytes of
// sha256("account:PriceUpdateV2")). Hardcoded in src/pyth.rs too.
const DISCRIMINATOR = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);

// Build PriceUpdateV2 bytes in the exact Borsh field order pyth.rs reads.
const buf = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
let off = 0;
DISCRIMINATOR.copy(buf, off); off += 8;
// write_authority (32 bytes): zero — never validated.
off += 32;
// verification_level: Borsh enum tag for Full (Partial=0, Full=1).
buf.writeUInt8(1, off); off += 1;
// PriceFeedMessage starts here.
Buffer.from(SOL_USD_FEED_ID_HEX, "hex").copy(buf, off); off += 32;
buf.writeBigInt64LE(100_000n, off); off += 8;       // price = 100_000
buf.writeBigUInt64LE(100n, off); off += 8;          // conf  = 100 (~0.1% — well under 1% cap)
buf.writeInt32LE(0, off); off += 4;                  // exponent (we don't normalize in v0)
buf.writeBigInt64LE(9223372036854775807n, off); off += 8;  // publish_time = i64::MAX
buf.writeBigInt64LE(9223372036854775807n, off); off += 8;  // prev_publish_time
buf.writeBigInt64LE(100_000n, off); off += 8;       // ema_price
buf.writeBigUInt64LE(100n, off); off += 8;          // ema_conf
// posted_slot
buf.writeBigUInt64LE(0n, off); off += 8;

if (off !== buf.length) throw new Error(`size mismatch: wrote ${off}, buf ${buf.length}`);

// rentEpoch must be u64::MAX as a literal integer; JSON.stringify on
// BigInt or large Number loses precision, so we hand-assemble the JSON.
const json = `{
  "pubkey": "${PRICE_ACCOUNT}",
  "account": {
    "lamports": 1825031,
    "data": [
      "${buf.toString("base64")}",
      "base64"
    ],
    "owner": "${PYTH_RECEIVER}",
    "executable": false,
    "rentEpoch": 18446744073709551615,
    "space": ${buf.length}
  }
}
`;

const outPath = join(REPO_ROOT, "tests", "fixtures", "pyth_sol_usd.json");
writeFileSync(outPath, json);
console.log(`wrote ${outPath} (${buf.length} bytes of account data)`);
