use crate::{
    constants::{BATCH_BUFFER_SEED, MARKET_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market, UserCollateral},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [BATCH_BUFFER_SEED, market.key().as_ref()],
        bump = batch_buffer.bump,
    )]
    pub batch_buffer: Box<Account<'info, BatchBuffer>>,

    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = user_collateral.bump,
        constraint = user_collateral.owner == user.key(),
    )]
    pub user_collateral: Box<Account<'info, UserCollateral>>,
}

// Cancel the caller's pending (unmatched) order in the open batch and refund its
// locked margin back to UserCollateral.
//
// Why this exists: every order MUST always be reclaimable. v0 collects orders in
// a single shared BatchBuffer and process_batch needs exactly 2 — so a lone order
// whose window closes before a partner arrives could otherwise lock the owner's
// margin forever AND brick the buffer for everyone (no carry-over / per-order
// accounts / timeout in v0). Owner-signed cancel is the minimal correct fix,
// mirroring cancel on every production Solana DEX (OpenBook / Phoenix / Mango).
//
// Rejected while a match is in flight (is_processing): the order may be settling.
pub fn cancel_order_handler(ctx: Context<CancelOrder>) -> Result<()> {
    let buf = &mut ctx.accounts.batch_buffer;
    let uc = &mut ctx.accounts.user_collateral;
    let owner = ctx.accounts.user.key();

    require!(!buf.is_processing, ErrorCode::BatchAlreadyProcessing);

    let n = buf.n_orders as usize;
    require!(n > 0, ErrorCode::BatchEmpty);

    // Find the caller's order slot (owner is plaintext for fill/refund routing).
    let mut found: Option<usize> = None;
    for i in 0..n {
        if buf.orders[i].owner == owner {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or(ErrorCode::NoPendingOrder)?;

    // Refund the locked margin.
    let refund = buf.orders[idx].max_margin;
    uc.balance = uc.balance.checked_add(refund).ok_or(ErrorCode::MathOverflow)?;

    // Compact the buffer: shift later orders down one, clear the freed tail slot,
    // decrement the count. Keeps orders[0..n_orders] dense so process_batch's
    // index-based pairing stays correct. When this empties the buffer, the next
    // submit_order reopens the window (n_orders == 0 branch).
    for i in idx..(n - 1) {
        buf.orders[i] = buf.orders[i + 1];
    }
    buf.orders[n - 1] = EncryptedOrderSlot::default();
    buf.n_orders = (n as u8).checked_sub(1).ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
