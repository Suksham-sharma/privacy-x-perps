use crate::{
    constants::{MARKET_SEED, USER_COLLATERAL_SEED},
    error::ErrorCode,
    state::{Market, UserCollateral},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [MARKET_SEED],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserCollateral::SIZE,
        seeds = [USER_COLLATERAL_SEED, market.key().as_ref(), user.key().as_ref()],
        bump,
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
    pub system_program: Program<'info, System>,
}

pub fn deposit_handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);

    // First deposit initializes the collateral PDA.
    let uc = &mut ctx.accounts.user_collateral;
    if uc.owner == Pubkey::default() {
        uc.owner = ctx.accounts.user.key();
        uc.bump = ctx.bumps.user_collateral;
    }

    // SPL transfer: user ATA -> program vault.
    let cpi = CpiContext::new(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.usdc_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::transfer(cpi, amount)?;

    uc.balance = uc
        .balance
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
