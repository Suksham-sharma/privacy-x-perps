use anchor_lang::prelude::*;

use crate::constants::MAX_ORDERS;

// SOL-PERP market. Init once, immutable thereafter (Drift-hack defensive).
#[account]
pub struct Market {
    pub admin: Pubkey,            // vestigial — no admin instructions exist
    pub pyth_feed: Pubkey,        // locked at init
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,       // program-owned USDC ATA
    pub batch_window_slots: u64,
    pub current_batch_id: u64,
    pub bump: u8,
}

impl Market {
    // discriminator (8) + admin (32) + pyth (32) + mint (32) + vault (32)
    //   + window (8) + batch_id (8) + bump (1)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1;
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
    // 32 + 32 + 16 + 4 * 32
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
    // discriminator (8) + market (32) + batch_id (8) + n_orders (1) + opened_at (8)
    //   + orders (MAX_ORDERS * SLOT) + bump (1)
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 8 + (MAX_ORDERS * EncryptedOrderSlot::SIZE) + 1;
}
