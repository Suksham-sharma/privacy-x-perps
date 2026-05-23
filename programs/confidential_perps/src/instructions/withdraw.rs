use crate::{
    constants::{BPS_DENOMINATOR, MARKET_SEED, USER_COLLATERAL_SEED, WITHDRAW_RATE_LIMIT_BPS},
    error::ErrorCode,
    state::{Market, UserCollateral},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = user_collateral.bump,
        constraint = user_collateral.owner == user.key(),
    )]
    pub user_collateral: Box<Account<'info, UserCollateral>>,

    #[account(
        mut,
        address = market.usdc_vault,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn withdraw_handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);

    let market = &mut ctx.accounts.market;
    let vault = &ctx.accounts.usdc_vault;
    let uc = &mut ctx.accounts.user_collateral;

    require!(uc.balance >= amount, ErrorCode::InsufficientCollateral);

    // Per-slot rate limit: snapshot vault on first withdraw of a slot,
    // cap subsequent withdraws in that slot at 5% of snapshot.
    let now = Clock::get()?.slot;
    if now != market.rate_limit_slot {
        market.rate_limit_slot = now;
        market.rate_limit_vault_snapshot = vault.amount;
        market.rate_limit_withdrawn = 0;
    }
    let max_per_slot = (market.rate_limit_vault_snapshot as u128)
        .checked_mul(WITHDRAW_RATE_LIMIT_BPS as u128)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(ErrorCode::MathOverflow)? as u64;
    let new_total = market
        .rate_limit_withdrawn
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(new_total <= max_per_slot, ErrorCode::WithdrawRateLimitExceeded);
    market.rate_limit_withdrawn = new_total;

    // SPL transfer: program vault -> user ATA. Market PDA is the vault authority.
    let seeds: &[&[u8]] = &[MARKET_SEED, &[market.bump]];
    let signer_seeds = &[seeds];
    let cpi = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.usdc_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: market.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi, amount)?;

    uc.balance = uc
        .balance
        .checked_sub(amount)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
