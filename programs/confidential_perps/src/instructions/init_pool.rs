// init_pool — fund the singleton batch-backstop pool (v0a). Permissionless / no
// admin gate (Drift-hack defensive). USDC goes into the SAME Market.usdc_vault as
// user collateral; pool equity = vault buffer over user balances (see Pool).
// `collateral` tracks cumulative funding; re-calling tops it up (idempotent).
use crate::{
    constants::{MARKET_SEED, POOL_SEED},
    error::ErrorCode,
    state::{Market, Pool},
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(seeds = [MARKET_SEED], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = funder,
        space = Pool::SIZE,
        seeds = [POOL_SEED, market.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = market.usdc_mint,
        token::authority = funder,
    )]
    pub funder_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_pool_handler(ctx: Context<InitPool>, amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);

    let pool = &mut ctx.accounts.pool;
    // init_if_needed zeroes a fresh account / leaves an existing one untouched,
    // so setting bump is idempotent and top-up just accumulates (no first-call branch).
    pool.bump = ctx.bumps.pool;

    // Move USDC funder ATA -> shared program vault.
    let cpi = CpiContext::new(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.usdc_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        },
    );
    token::transfer(cpi, amount)?;

    pool.collateral = pool
        .collateral
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
