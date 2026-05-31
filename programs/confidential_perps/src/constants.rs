use anchor_lang::prelude::*;
use arcium_anchor::comp_def_offset;

#[constant]
pub const SEED: &str = "arcium";

// Pyth Pull Oracle receiver — same id on devnet+mainnet; localnet clones it
// (and the SOL/USD feed) from devnet so the owner check passes.
pub const PYTH_RECEIVER_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// SOL/USD Pyth feed id (32-byte asset identifier, NOT an account pubkey);
// stable per asset across deployments. Hex: 0xef0d8b6f...c280b56d
pub const SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

// Max Pyth price staleness. 30s (Drift/Mango-style); `test-stale-ok` loosens
// to 10min so localnet can read a cloned-from-devnet account with frozen publish_time.
#[cfg(feature = "test-stale-ok")]
pub const MAX_PRICE_AGE_SECS: u64 = 600;
#[cfg(not(feature = "test-stale-ok"))]
pub const MAX_PRICE_AGE_SECS: u64 = 30;

// Reject prices whose conf interval exceeds this fraction of price (100bps=1%).
// Drift-style guardrail: wide conf = publishers disagree = liquidation-cascade risk.
pub const MAX_PRICE_CONF_BPS: u64 = 100;

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const BATCH_BUFFER_SEED: &[u8] = b"batch";

#[constant]
pub const USER_COLLATERAL_SEED: &[u8] = b"collateral";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

// Singleton liquidity pool per market — the guaranteed counterparty that
// absorbs the net imbalance of each batch at the oracle price (v0a).
#[constant]
pub const POOL_SEED: &[u8] = b"pool";

// DEMO/LOCALNET ONLY (feature = "mock-oracle"): seed for the program-owned mock
// PriceUpdateV2 a localnet crank keeps fresh. See set_mock_oracle.
#[cfg(feature = "mock-oracle")]
#[constant]
pub const MOCK_ORACLE_SEED: &[u8] = b"mock_oracle";

// Drift-hack defensive: per-slot withdrawal cap = 5% of vault snapshot.
pub const WITHDRAW_RATE_LIMIT_BPS: u64 = 500;
pub const BPS_DENOMINATOR: u64 = 10_000;

// Fixed circuit arity — MUST equal the N match_batch is compiled for
// (encrypted-ixs/src/lib.rs). N=4 (~1B ACU vs 1.96B at N=8); small callback list.
pub const MAX_ORDERS: usize = 4;

// Skew cap (v0a safety): max abs net base the pool may hold. NOT YET ENFORCED —
// v0 relies on generous funding + small demo sizes + the conf gate; circuit-side
// enforcement is the next hardening pass. Tracked so it's not silently absent.
pub const MAX_POOL_BASE: u64 = 1_000_000;

// Batch window. 50 slots (~20s) gives the human-paced /trade flow room (5 slots
// was fine for tight test submits but too short for a browser UI). Mainnet tunes this.
pub const DEFAULT_BATCH_WINDOW_SLOTS: u64 = 50;

// Pyth oracle band: clearing price must be within ±5% of the spot.
pub const ORACLE_BAND_BPS: u64 = 500;

// Computation definition offsets.
pub const COMP_DEF_OFFSET_ADD_TOGETHER: u32 = comp_def_offset("add_together");
pub const COMP_DEF_OFFSET_MATCH_BATCH: u32 = comp_def_offset("match_batch");
