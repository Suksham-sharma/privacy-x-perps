use crate::{
    constants::{BATCH_BUFFER_SEED, MARKET_SEED, MAX_ORDERS},
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SubmitOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [BATCH_BUFFER_SEED, market.key().as_ref()],
        bump = batch_buffer.bump,
    )]
    pub batch_buffer: Box<Account<'info, BatchBuffer>>,
}

pub fn submit_order_handler(
    ctx: Context<SubmitOrder>,
    x25519_pubkey: [u8; 32],
    nonce: u128,
    ct_side: [u8; 32],
    ct_price: [u8; 32],
    ct_size: [u8; 32],
    ct_client_nonce: [u8; 32],
) -> Result<()> {
    let buf = &mut ctx.accounts.batch_buffer;
    let market = &ctx.accounts.market;

    require!((buf.n_orders as usize) < MAX_ORDERS, ErrorCode::BatchFull);

    let now_slot = Clock::get()?.slot;

    // First order in a fresh batch opens the window.
    if buf.n_orders == 0 {
        buf.opened_at_slot = now_slot;
    } else {
        let closes_at = buf
            .opened_at_slot
            .checked_add(market.batch_window_slots)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(now_slot < closes_at, ErrorCode::BatchWindowClosed);
    }

    let idx = buf.n_orders as usize;
    buf.orders[idx] = EncryptedOrderSlot {
        owner: ctx.accounts.user.key(),
        x25519_pubkey,
        nonce,
        ct_side,
        ct_price,
        ct_size,
        ct_client_nonce,
    };
    buf.n_orders = buf.n_orders.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
