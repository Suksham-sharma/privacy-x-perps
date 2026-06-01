// expire_batch — permissionless escape hatch for a WEDGED BatchBuffer.
//
// When an Arcium computation is dropped (accepted into the cluster's execpool but
// never executed, so its callback never fires), `is_processing` stays `true`
// forever and blocks every new submit_order / cancel_order / process_batch — the
// market is bricked. v0 had no recovery path (the callback was the only writer of
// `is_processing = false`). This instruction lets ANYONE reset the buffer once
// EXPIRE_BATCH_SLOTS have elapsed since the batch opened — long enough (~10 min)
// that it can never race a batch that is settling normally.
//
// v0 caveat: locked margin of the orders in the wedged batch is NOT refunded here
// (that needs the variable-count UserCollateral PDAs as remaining accounts).
// Acceptable for a recovery hatch on devnet; a production expire would refund the
// stuck orders before resetting.
use crate::{
    constants::{BATCH_BUFFER_SEED, EXPIRE_BATCH_SLOTS, MARKET_SEED, MAX_ORDERS},
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ExpireBatch<'info> {
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

pub fn expire_batch_handler(ctx: Context<ExpireBatch>) -> Result<()> {
    let buf = &mut ctx.accounts.batch_buffer;

    // Only a batch actually in flight (callback pending) can be wedged. A batch
    // that is merely open (collecting orders) is unblocked by process_batch.
    require!(buf.is_processing, ErrorCode::BatchNotProcessing);

    let now_slot = Clock::get()?.slot;
    let expires_at = buf
        .opened_at_slot
        .checked_add(EXPIRE_BATCH_SLOTS)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now_slot >= expires_at, ErrorCode::BatchNotExpired);

    // Reset the buffer (same shape as the callback's reset, minus fills/refunds).
    buf.n_orders = 0;
    buf.opened_at_slot = 0;
    buf.orders = [EncryptedOrderSlot::default(); MAX_ORDERS];
    buf.batch_id = buf.batch_id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    buf.is_processing = false;

    Ok(())
}
