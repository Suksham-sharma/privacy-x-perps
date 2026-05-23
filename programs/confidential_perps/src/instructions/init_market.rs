use crate::{
    constants::{BATCH_BUFFER_SEED, DEFAULT_BATCH_WINDOW_SLOTS, MARKET_SEED},
    state::{BatchBuffer, EncryptedOrderSlot, Market},
};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = Market::SIZE,
        seeds = [MARKET_SEED],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = admin,
        space = BatchBuffer::SIZE,
        seeds = [BATCH_BUFFER_SEED, market.key().as_ref()],
        bump,
    )]
    pub batch_buffer: Box<Account<'info, BatchBuffer>>,

    /// CHECK: stored on Market; not dereferenced here. Pyth client validates on read.
    pub pyth_feed: UncheckedAccount<'info>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = usdc_mint,
        associated_token::authority = market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn init_market_handler(ctx: Context<InitMarket>) -> Result<()> {
    let m = &mut ctx.accounts.market;
    m.admin = ctx.accounts.admin.key();
    m.pyth_feed = ctx.accounts.pyth_feed.key();
    m.usdc_mint = ctx.accounts.usdc_mint.key();
    m.usdc_vault = ctx.accounts.usdc_vault.key();
    m.batch_window_slots = DEFAULT_BATCH_WINDOW_SLOTS;
    m.current_batch_id = 0;
    m.bump = ctx.bumps.market;
    m.rate_limit_slot = 0;
    m.rate_limit_vault_snapshot = 0;
    m.rate_limit_withdrawn = 0;

    let b = &mut ctx.accounts.batch_buffer;
    b.market = m.key();
    b.batch_id = 0;
    b.n_orders = 0;
    b.opened_at_slot = 0;
    b.orders = [EncryptedOrderSlot::default(); crate::constants::MAX_ORDERS];
    b.bump = ctx.bumps.batch_buffer;

    Ok(())
}
