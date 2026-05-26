// liquidate_position — third-party close when a position can no longer cover
// its maintenance margin. v0 is permissionless (anyone can call) with no
// bounty; v0.2 adds a bounty taken from the position's remaining credit.
//
// Trust model is identical to close_position: the caller supplies
// exit_price. v0 trusts the caller; v0.2 will gate it on a Pyth-validated
// price band so a liquidator cannot pick a wild exit_price to manufacture
// an "underwater" state. Until then, liquidation should be invoked by the
// protocol-operated keeper only.
//
// Liquidatable when credit < margin_locked / 2 (50% maintenance margin).
//   credit = margin_locked + PnL
//   PnL    = base_amount_lots * exit_price + quote_entry
// Any positive credit goes to the position owner; v0 takes no fee.
use crate::{
    constants::{MARKET_SEED, POSITION_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
    state::{Market, Position, UserCollateral},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct LiquidatePosition<'info> {
    pub liquidator: Signer<'info>,

    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    // Position belongs to position.owner (the to-be-liquidated user), NOT
    // the liquidator. Self-liquidation is rejected in the handler to keep
    // the gate semantics meaningful.
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    // The owner's UserCollateral — receives any remaining credit.
    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = user_collateral.bump,
        constraint = user_collateral.owner == position.owner,
    )]
    pub user_collateral: Box<Account<'info, UserCollateral>>,
}

#[event]
pub struct PositionLiquidatedEvent {
    pub owner: Pubkey,
    pub liquidator: Pubkey,
    pub exit_price: u64,
    pub base_amount_lots: i64,
    pub realized_pnl: i128,
    pub credit_returned: u64,
}

pub fn liquidate_position_handler(
    ctx: Context<LiquidatePosition>,
    exit_price: u64,
) -> Result<()> {
    require!(exit_price > 0, ErrorCode::ZeroAmount);

    let pos = &mut ctx.accounts.position;
    let uc = &mut ctx.accounts.user_collateral;

    require!(pos.base_amount_lots != 0, ErrorCode::NoOpenPosition);
    require_keys_neq!(
        pos.owner,
        ctx.accounts.liquidator.key(),
        ErrorCode::SelfLiquidationNotAllowed
    );

    let pnl = (pos.base_amount_lots as i128)
        .checked_mul(exit_price as i128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_add(pos.quote_entry)
        .ok_or(ErrorCode::MathOverflow)?;

    let credit_i128 = (pos.margin_locked as i128)
        .checked_add(pnl)
        .ok_or(ErrorCode::MathOverflow)?;

    // Maintenance margin gate: liquidatable when credit < margin / 2.
    // (Includes the bankrupt case credit < 0 — strictly less than the
    // positive threshold.)
    let maintenance = (pos.margin_locked as i128) / 2;
    require!(credit_i128 < maintenance, ErrorCode::PositionNotLiquidatable);

    // Settle whatever's left to the owner; clamp negative credit to 0
    // (the protocol-side loss isn't socialized in v0 — no insurance fund).
    let credit_returned: u64 = if credit_i128 <= 0 {
        0
    } else {
        u64::try_from(credit_i128).map_err(|_| ErrorCode::MathOverflow)?
    };
    if credit_returned > 0 {
        uc.balance = uc
            .balance
            .checked_add(credit_returned)
            .ok_or(ErrorCode::MathOverflow)?;
    }

    let base_at_liq = pos.base_amount_lots;
    let owner_at_liq = pos.owner;
    pos.base_amount_lots = 0;
    pos.quote_entry = 0;
    pos.margin_locked = 0;

    emit!(PositionLiquidatedEvent {
        owner: owner_at_liq,
        liquidator: ctx.accounts.liquidator.key(),
        exit_price,
        base_amount_lots: base_at_liq,
        realized_pnl: pnl,
        credit_returned,
    });

    Ok(())
}
