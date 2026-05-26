// close_position — user-initiated exit. Computes realized PnL at the
// caller-supplied exit_price, releases margin + PnL back to UserCollateral,
// zeros the Position. v0 trusts the exit_price (Pyth wrapper is a later
// task); v0 also refuses to settle underwater positions — those go through
// the liquidation path (TBD).
//
// PnL formula (v0, lot-ticks treated 1:1 with USDC base units — see the
// Position doc comment in state/mod.rs):
//   realized_pnl = base_amount_lots * exit_price + quote_entry
//   credit       = margin_locked + realized_pnl
// If credit < 0 the position cannot self-close.
use crate::{
    constants::{MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
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
}

#[event]
pub struct PositionClosedEvent {
    pub owner: Pubkey,
    pub exit_price: u64,
    pub base_amount_lots: i64, // base at close time (pre-zero)
    pub realized_pnl: i128,    // lot-ticks (~= USDC base units in v0)
    pub credit: u64,           // margin + pnl, what UserCollateral gained
}

pub fn close_position_handler(
    ctx: Context<ClosePosition>,
    exit_price: u64,
) -> Result<()> {
    require!(exit_price > 0, ErrorCode::ZeroAmount);

    let pos = &mut ctx.accounts.position;
    let uc = &mut ctx.accounts.user_collateral;

    require!(pos.base_amount_lots != 0, ErrorCode::NoOpenPosition);

    // realized_pnl = base * exit + quote_entry (signed, in lot-ticks).
    let pnl = (pos.base_amount_lots as i128)
        .checked_mul(exit_price as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_add(pos.quote_entry)
        .ok_or(ErrorCode::MathOverflow)?;

    // Total credit = margin_locked + PnL. v0 refuses to settle underwater.
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
