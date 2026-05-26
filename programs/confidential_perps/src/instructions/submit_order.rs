use crate::{
    constants::{BATCH_BUFFER_SEED, MARKET_SEED, MAX_ORDERS, POSITION_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market, Position, UserCollateral},
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

    // User must have deposited at least once. No init_if_needed: an order
    // requires real collateral, not a freshly-created zero-balance PDA.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = user_collateral.bump,
        constraint = user_collateral.owner == user.key(),
    )]
    pub user_collateral: Box<Account<'info, UserCollateral>>,

    // Lazy-init so match_batch_callback (which has no user Signer / payer)
    // can take this PDA as `mut` without `init_if_needed`. First submit pays
    // the rent; subsequent submits no-op.
    #[account(
        init_if_needed,
        payer = user,
        space = Position::SIZE,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,

    pub system_program: Program<'info, System>,
}

pub fn submit_order_handler(
    ctx: Context<SubmitOrder>,
    x25519_pubkey: [u8; 32],
    nonce: u128,
    max_margin: u64,
    ct_side: [u8; 32],
    ct_price: [u8; 32],
    ct_size: [u8; 32],
    ct_client_nonce: [u8; 32],
) -> Result<()> {
    require!(max_margin > 0, ErrorCode::ZeroAmount);

    let buf = &mut ctx.accounts.batch_buffer;
    let market = &ctx.accounts.market;
    let uc = &mut ctx.accounts.user_collateral;

    // Stamp Position fields on first submit (init_if_needed leaves zeros).
    let pos = &mut ctx.accounts.position;
    if pos.owner == Pubkey::default() {
        pos.owner = ctx.accounts.user.key();
        pos.bump = ctx.bumps.position;
    }

    require!(!buf.is_processing, ErrorCode::BatchAlreadyProcessing);
    require!((buf.n_orders as usize) < MAX_ORDERS, ErrorCode::BatchFull);

    // Lock margin first — fail closed before mutating the batch buffer.
    require!(uc.balance >= max_margin, ErrorCode::InsufficientCollateral);
    uc.balance = uc
        .balance
        .checked_sub(max_margin)
        .ok_or(ErrorCode::MathOverflow)?;

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
        max_margin,
        ct_side,
        ct_price,
        ct_size,
        ct_client_nonce,
    };
    buf.n_orders = buf.n_orders.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
