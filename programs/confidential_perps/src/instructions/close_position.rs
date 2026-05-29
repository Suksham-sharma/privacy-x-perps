// close_position — user-initiated exit. Reads the current Pyth price as the
// exit price (the user does NOT supply one), then releases margin + realized
// PnL back to UserCollateral and zeros the Position.
//
// No user-supplied exit_price (Codex review fix): with no exit counterparty, a
// caller-chosen price inside a band is free optionality — a long picks the top,
// a short the bottom, a liquidator the worst value for the victim. Settling at
// the oracle removes that surface. liquidate_position.rs is the same pattern.
//
// PnL (v0, lot-ticks 1:1 with USDC base units — see Position in state/mod.rs):
//   realized_pnl = base_amount_lots * oracle_price + quote_entry
//   credit       = margin_locked + realized_pnl
// If credit < 0 the position can't self-close — goes through liquidation.
use crate::{
    constants::{MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
    pyth::read_pyth_price,
    state::{Market, Position, UserCollateral},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub user: Signer<'info>,

    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key(),
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = user_collateral.bump,
        constraint = user_collateral.owner == user.key(),
    )]
    pub user_collateral: Box<Account<'info, UserCollateral>>,

    /// CHECK: validated as Pyth PriceUpdateV2 in read_pyth_price. See
    /// the ProcessBatch doc comment for the same UncheckedAccount rationale.
    pub price_update: UncheckedAccount<'info>,
}

#[event]
pub struct PositionClosedEvent {
    pub owner: Pubkey,
    pub exit_price: u64,       // Pyth-sourced; in market's tick units
    pub base_amount_lots: i64, // base at close time (pre-zero)
    pub realized_pnl: i128,    // lot-ticks (~= USDC base units in v0)
    pub credit: u64,           // margin + pnl, what UserCollateral gained
}

pub fn close_position_handler(ctx: Context<ClosePosition>) -> Result<()> {
    // Pyth-sourced exit price. Validates owner, freshness, feed_id, conf.
    let exit_price = read_pyth_price(
        &ctx.accounts.price_update.to_account_info(),
        &ctx.accounts.market.pyth_feed_id,
        &Clock::get()?,
    )?;

    let pos = &mut ctx.accounts.position;
    let uc = &mut ctx.accounts.user_collateral;

    require!(pos.base_amount_lots != 0, ErrorCode::NoOpenPosition);

    let pnl = (pos.base_amount_lots as i128)
        .checked_mul(exit_price as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_add(pos.quote_entry)
        .ok_or(ErrorCode::MathOverflow)?;

    let credit_i128 = (pos.margin_locked as i128)
        .checked_add(pnl)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(credit_i128 >= 0, ErrorCode::PositionUnderwater);
    let credit = u64::try_from(credit_i128).map_err(|_| ErrorCode::MathOverflow)?;

    uc.balance = uc
        .balance
        .checked_add(credit)
        .ok_or(ErrorCode::MathOverflow)?;

    let base_at_close = pos.base_amount_lots;
    pos.base_amount_lots = 0;
    pos.quote_entry = 0;
    pos.margin_locked = 0;

    emit!(PositionClosedEvent {
        owner: pos.owner,
        exit_price,
        base_amount_lots: base_at_close,
        realized_pnl: pnl,
        credit,
    });

    Ok(())
}
