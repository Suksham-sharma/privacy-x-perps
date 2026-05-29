use anchor_lang::prelude::*;
use arcium_anchor::comp_def_offset;

#[constant]
pub const SEED: &str = "arcium";

// Pyth Pull Oracle receiver — same program id on devnet + mainnet.
// On localnet the test setup clones this program from devnet so the owner
// check below passes. Sponsored SOL/USD feed account is cloned alongside.
// https://docs.pyth.network/price-feeds/core/contract-addresses/solana
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// SOL/USD Pyth feed id (32-byte asset identifier, NOT an account pubkey).
// Stable per asset across all Pyth deployments.
// Hex: 0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d
pub const SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

// Max staleness for a Pyth price we'll accept. 30s is the perp-engine
// default (matches Drift / Mango tolerances). The `test-stale-ok` feature
// loosens it to 10 min so localnet tests can read a cloned-from-devnet
// PriceUpdateV2 account whose publish_time is frozen at clone-time.
#[cfg(feature = "test-stale-ok")]
pub const MAX_PRICE_AGE_SECS: u64 = 600;
#[cfg(not(feature = "test-stale-ok"))]
pub const MAX_PRICE_AGE_SECS: u64 = 30;

// Reject prices whose confidence interval is more than this fraction of
// the price. 100 bps = 1%. Drift-style guardrail: a wide conf means the
// publishers disagree, and trusting an unstable price for perp settlement
// is asking for liquidation cascades.
pub const MAX_PRICE_CONF_BPS: u64 = 100;

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const BATCH_BUFFER_SEED: &[u8] = b"batch";

#[constant]
pub const USER_COLLATERAL_SEED: &[u8] = b"collateral";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

// Drift-hack defensive: per-slot withdrawal cap = 5% of vault snapshot.
pub const WITHDRAW_RATE_LIMIT_BPS: u64 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

// Batch auction params. Tune in Week 3 once we measure ACUs.
pub const MAX_ORDERS: usize = 8;

// Batch window. 5 slots (~2s) is fine for the tight back-to-back submits in the
// test/lifecycle-driver, but unusable for a human-paced UI where one side is
// placed in the browser and the other arrives moments later — a lone order whose
// window closes before a match bricks the buffer (no cancel/reset in v0). 50
// slots (~20s) gives the /trade flow comfortable room. Mainnet would tune this.
pub const DEFAULT_BATCH_WINDOW_SLOTS: u64 = 50;

// Pyth oracle band: clearing price must be within ±5% of the spot.
pub const ORACLE_BAND_BPS: u64 = 500;

// Computation definition offsets.
pub const COMP_DEF_OFFSET_ADD_TOGETHER: u32 = comp_def_offset("add_together");
pub const COMP_DEF_OFFSET_MATCH_BATCH: u32 = comp_def_offset("match_batch");
