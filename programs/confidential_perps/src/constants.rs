use anchor_lang::prelude::*;
use arcium_anchor::comp_def_offset;

#[constant]
pub const SEED: &str = "arcium";

#[constant]
pub const MARKET_SEED: &[u8] = b"market";

#[constant]
pub const BATCH_BUFFER_SEED: &[u8] = b"batch";

// Batch auction params. Tune in Week 3 once we measure ACUs.
pub const MAX_ORDERS: usize = 8;

// ~2s window on mainnet (400 ms slots).
pub const DEFAULT_BATCH_WINDOW_SLOTS: u64 = 5;

// Pyth oracle band: clearing price must be within ±5% of the spot.
pub const ORACLE_BAND_BPS: u64 = 500;

// Computation definition offsets.
pub const COMP_DEF_OFFSET_ADD_TOGETHER: u32 = comp_def_offset("add_together");
pub const COMP_DEF_OFFSET_MATCH_BATCH: u32 = comp_def_offset("match_batch");
