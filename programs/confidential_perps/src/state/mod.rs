use anchor_lang::prelude::*;

use crate::constants::MAX_ORDERS;

// SOL-PERP market. Init once, immutable thereafter (Drift-hack defensive).
// No admin field by design — no admin instructions exist, ever.
#[account]
pub struct Market {
    pub pyth_feed: Pubkey,        // locked at init
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
    // discriminator + pyth + mint + vault + window + batch_id + bump
    //   + rate_limit_slot + rate_limit_vault_snapshot + rate_limit_withdrawn
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 8 + 8 + 8;
}

// One encrypted order slot in the batch buffer.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct EncryptedOrderSlot {
    pub owner: Pubkey,            // for fill / refund routing
    pub x25519_pubkey: [u8; 32],  // client ephemeral pubkey for the shared secret
    pub nonce: u128,              // per-order encryption nonce
    pub ct_side: [u8; 32],        // encrypted: 0 long / 1 short
    pub ct_price: [u8; 32],       // encrypted: ticks
    pub ct_size: [u8; 32],        // encrypted: lots
    pub ct_client_nonce: [u8; 32],// encrypted: client-chosen u64 for fill correlation
}

impl EncryptedOrderSlot {
    pub const SIZE: usize = 32 + 32 + 16 + 32 + 32 + 32 + 32;
}

// Rolling buffer. Reused across batches: process_batch resets n_orders and bumps batch_id.
#[account]
pub struct BatchBuffer {
    pub market: Pubkey,
    pub batch_id: u64,
    pub n_orders: u8,
    pub opened_at_slot: u64,
    pub orders: [EncryptedOrderSlot; MAX_ORDERS],
    pub bump: u8,
}

impl BatchBuffer {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 8 + (MAX_ORDERS * EncryptedOrderSlot::SIZE) + 1;
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
