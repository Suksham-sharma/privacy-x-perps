use anchor_lang::prelude::*;

use crate::constants::MAX_ORDERS;

// SOL-PERP market. Init once, immutable thereafter (Drift-hack defensive).
// No admin field by design — no admin instructions exist, ever.
//
// `pyth_feed_id` is the 32-byte Pyth feed identifier (NOT a Pubkey of an
// account). Pyth's `PriceUpdateV2` accounts have unstable addresses (a
// fresh keypair per update), but each carries a stable feed_id inside. We
// pin the feed_id at init and validate every passed price_update account
// against it. For SOL/USD the feed_id is `SOL_USD_FEED_ID` in constants.rs.
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

// One encrypted order slot in the batch buffer.
//
// max_margin is PUBLIC by design — it's the USDC base-unit amount locked
// from UserCollateral.balance at submit_order. Refunded on NoMatch; retained
// on any fill (v0 doesn't refund partial-fill excess because the circuit
// doesn't reveal original size — only fill_size — so a proportional refund
// would leak the order size). v0 trusts the user to size max_margin against
// their own encrypted notional; circuit-side margin validation is v0.2.
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

// Rolling buffer. Reused across batches: process_batch flips is_processing,
// callback resets n_orders + orders[] and bumps batch_id.
//
// is_processing semantics:
//   false at init and after each callback;
//   true between process_batch (queue_computation) and the callback firing.
// While true: submit_order rejects new orders, and process_batch refuses to
// re-queue (no double-spend of the same encrypted orders). v0 caveat: if
// Arcium drops the computation the buffer is stuck until manual recovery;
// timeout / cancel flow is v0.2 work.
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

// Per-user perp position. One per (market, owner). Plain (publicly readable)
// in v0 — see docs/circuit-v0.md "v0 vs v0.2". Encrypted commitment variant
// is task #21 / v0.2.
//
// Units (v0):
//   base_amount_lots — signed lots of base (SOL). + long, - short.
//   quote_entry     — signed cumulative cost basis in lot-ticks
//                      (sum over fills of ±fill_size_lots * clearing_price_ticks).
//                      Negative when long (you paid quote), positive when short
//                      (you received quote). i128 absorbs accumulation across
//                      many fills without overflow.
//   margin_locked   — sum of max_margin from every order that has filled into
//                      this position, in USDC base units. Released back to
//                      UserCollateral at close. v0 doesn't refund partial-fill
//                      excess at fill time (would leak order size), so this
//                      is always the *committed* margin, not the
//                      *required* margin.
//
// Unit convention (v0): lot-ticks treated 1:1 with USDC base units. Position
// PnL = base_amount_lots * exit_price + quote_entry is therefore directly
// comparable to margin_locked (both u64-scale-equivalent). Real
// TICK_SIZE/LOT_SIZE calibration is post-v0.
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
