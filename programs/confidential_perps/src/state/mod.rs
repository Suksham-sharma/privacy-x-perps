use anchor_lang::prelude::*;

use crate::constants::MAX_ORDERS;

// SOL-PERP market. Init once, immutable (Drift-hack defensive); no admin field
// by design. `pyth_feed_id` is the 32-byte feed id (NOT an account pubkey —
// PriceUpdateV2 addresses are unstable, the feed_id inside is stable); pinned at
// init and validated against every price_update. SOL/USD = SOL_USD_FEED_ID.
#[account]
pub struct Market {
    pub pyth_feed_id: [u8; 32],   // locked at init; 32-byte Pyth asset id
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,       // program-controlled USDC ATA (authority = this Market PDA)
    pub batch_window_slots: u64,
    pub current_batch_id: u64,
    pub bump: u8,

    // Per-slot withdrawal rate limiter.
    pub rate_limit_slot: u64,       // last slot at which the snapshot was taken
    pub rate_limit_vault_snapshot: u64, // vault balance at start of that slot
    pub rate_limit_withdrawn: u64,  // sum withdrawn in that slot
}

impl Market {
    // discriminator + feed_id(32) + mint + vault + window + batch_id + bump
    //   + rate_limit_slot + rate_limit_vault_snapshot + rate_limit_withdrawn
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 8;
}

// One encrypted order slot in the batch buffer. max_margin is PUBLIC by design
// (USDC locked at submit, refunded on NoMatch / retained on fill — v0 can't
// refund partial-fill excess without leaking original size). Circuit-side margin
// validation is v0.2.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct EncryptedOrderSlot {
    pub owner: Pubkey,            // for fill / refund routing
    pub x25519_pubkey: [u8; 32],  // client ephemeral pubkey for the shared secret
    pub nonce: u128,              // per-order encryption nonce
    pub max_margin: u64,          // USDC base units locked at submit; see note above
    pub ct_side: [u8; 32],        // encrypted: 0 long / 1 short
    pub ct_price: [u8; 32],       // encrypted: ticks
    pub ct_size: [u8; 32],        // encrypted: lots
    pub ct_client_nonce: [u8; 32],// encrypted: client-chosen u64 for fill correlation
}

impl EncryptedOrderSlot {
    pub const SIZE: usize = 32 + 32 + 16 + 8 + 32 + 32 + 32 + 32;
}

// Rolling buffer reused across batches: process_batch flips is_processing, the
// callback resets n_orders+orders[] and bumps batch_id. is_processing (true
// between queue and callback) blocks new submits + re-queue => no double-spend of
// the same orders. v0 caveat: a dropped Arcium computation sticks the buffer
// until manual recovery; timeout/cancel is v0.2.
#[account]
pub struct BatchBuffer {
    pub market: Pubkey,
    pub batch_id: u64,
    pub n_orders: u8,
    pub opened_at_slot: u64,
    pub orders: [EncryptedOrderSlot; MAX_ORDERS],
    pub bump: u8,
    pub is_processing: bool,
}

impl BatchBuffer {
    // discriminator + market + batch_id + n_orders + opened_at_slot
    //   + orders[] + bump + is_processing
    pub const SIZE: usize =
        8 + 32 + 8 + 1 + 8 + (MAX_ORDERS * EncryptedOrderSlot::SIZE) + 1 + 1;
}

// Per-user collateral balance (USDC base units, held in Market.usdc_vault).
#[account]
pub struct UserCollateral {
    pub owner: Pubkey,
    pub balance: u64,
    pub bump: u8,
}

impl UserCollateral {
    // discriminator + owner + balance + bump
    pub const SIZE: usize = 8 + 32 + 8 + 1;
}

// Per-user perp position, one per (market, owner). Publicly readable in v0
// (encrypted commitment is v0.2). Units (v0):
//   base_amount_lots — signed lots of base (SOL): + long, - short.
//   quote_entry     — signed cost basis in lot-ticks (Σ ±size*price), i128.
//   margin_locked   — Σ max_margin of filled orders (USDC base units), released
//                      at close; committed not required (no partial-fill refund — leaks size).
// lot-ticks ≈ USDC base units 1:1, so PnL = base*exit_price + quote_entry is
// comparable to margin_locked. Real TICK_SIZE/LOT_SIZE calibration is post-v0.
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub base_amount_lots: i64,
    pub quote_entry: i128,
    pub margin_locked: u64,
    pub bump: u8,
}

impl Position {
    // discriminator + owner + base + quote + margin + bump
    pub const SIZE: usize = 8 + 32 + 8 + 16 + 8 + 1;
}

// Singleton per-market liquidity pool (v0a) — guaranteed counterparty that
// absorbs the residual at the oracle price: pool base += (short - long), untouched
// when balanced. base_amount_lots/quote_entry mirror Position's units, so PnL =
// base*mark + quote_entry. `collateral` tracks init_pool funding into
// Market.usdc_vault; v0 simplification: pool equity = vault buffer over Σ user
// collateral, trader PnL paid from that shared buffer. SAFETY: continuous solvency
// settlement + the MAX_POOL_BASE skew cap are the next hardening pass (constants.rs).
#[account]
pub struct Pool {
    pub base_amount_lots: i64,
    pub quote_entry: i128,
    pub collateral: u64,
    pub bump: u8,
}

impl Pool {
    // discriminator + base + quote + collateral + bump
    pub const SIZE: usize = 8 + 8 + 16 + 8 + 1;
}
