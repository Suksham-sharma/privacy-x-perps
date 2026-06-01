// process_batch — closes the batch window and queues match_batch (v0a) in Arcium.
// Permissionless once gates pass (>=1 order, window closed, not in flight); payer
// pays Arcium fees. Matches 1..MAX_ORDERS orders + a pool backstop (lone order
// fills the pool, no brick); empty slots pad with orders[0], masked by n_active.
use crate::{
    constants::{
        BATCH_BUFFER_SEED, COMP_DEF_OFFSET_MATCH_BATCH, MARKET_SEED, MAX_ORDERS, POOL_SEED,
        POSITION_SEED, USER_COLLATERAL_SEED,
    },
    error::ErrorCode,
    instructions::match_batch::MatchBatchOcCallback,
    state::{BatchBuffer, Market},
    ArciumSignerAccount,
    ID,
    ID_CONST,
};
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

#[queue_computation_accounts("match_batch_oc", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ProcessBatch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // Arcium signer PDA — required by the queue_computation_accounts macro.
    // Same pattern as add_together.
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,

    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: arcium mempool, validated by arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: arcium executing pool, validated by arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: per-computation account at derive_comp_pda; arcium program
    /// initializes + checks during queue_computation.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_BATCH))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,

    // our domain accounts

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

    /// CHECK: validated as a Pyth PriceUpdateV2 in the handler via
    /// `read_pyth_price`. UncheckedAccount because the SDK's typed
    /// Account<PriceUpdateV2> needs anchor-lang ^0.32.1 (Arcium pins us to
    /// 1.0.2); we hand-roll the struct in src/pyth.rs.
    pub price_update: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

pub fn process_batch_handler(
    ctx: Context<ProcessBatch>,
    computation_offset: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;

    // Read the oracle price BEFORE any state mutation; if Pyth's stale or
    // mismatched, we fail closed and the batch stays open for retry.
    let oracle_price = crate::pyth::read_pyth_price(
        &ctx.accounts.price_update.to_account_info(),
        &market.pyth_feed_id,
        &Clock::get()?,
    )?;

    let buf = &mut ctx.accounts.batch_buffer;
    require!(!buf.is_processing, ErrorCode::BatchAlreadyProcessing);
    // v0a: any non-empty batch can settle (lone orders fill against the pool).
    let n = buf.n_orders as usize;
    require!(n >= 1, ErrorCode::BatchNotReady);

    let now_slot = Clock::get()?.slot;
    let closes_at = buf
        .opened_at_slot
        .checked_add(market.batch_window_slots)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now_slot >= closes_at, ErrorCode::BatchWindowOpen);

    // Required by the queue_computation_accounts macro pattern.
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    // Circuit args: MAX_ORDERS Enc<Shared,Order> envelopes (x25519 pubkey + nonce
    // + ct fields in struct order: side/price/size/client_nonce), then public
    // n_active + oracle_price. Slots >= n_orders pad with orders[0] (masked by
    // n_active) — avoids feeding an all-zero invalid x25519 pubkey to decryption.
    let mut args = ArgBuilder::new();
    for i in 0..MAX_ORDERS {
        let o = if i < n { buf.orders[i] } else { buf.orders[0] };
        args = args
            .x25519_pubkey(o.x25519_pubkey)
            .plaintext_u128(o.nonce)
            .encrypted_u8(o.ct_side)
            .encrypted_u64(o.ct_price)
            .encrypted_u64(o.ct_size)
            .encrypted_u64(o.ct_client_nonce);
    }
    let args = args
        .plaintext_u64(buf.n_orders as u64)
        .plaintext_u64(oracle_price)
        .build();

    // Callback extra accounts in MatchBatchOcCallback's declared order:
    // [market, batch_buffer, pool, position_0..3, user_collateral_0..3]. PDAs
    // derive against orders[i].owner (callback must reset the buffer only after
    // fills land); slots >= n_orders are market-key padding the callback ignores.
    let market_key = market.key();
    let (pool_key, _) =
        Pubkey::find_program_address(&[POOL_SEED, market_key.as_ref()], &crate::ID);

    let mut positions = [market_key; MAX_ORDERS];
    let mut collaterals = [market_key; MAX_ORDERS];
    for i in 0..n {
        let owner = buf.orders[i].owner;
        positions[i] = Pubkey::find_program_address(
            &[POSITION_SEED, market_key.as_ref(), owner.as_ref()],
            &crate::ID,
        )
        .0;
        collaterals[i] = Pubkey::find_program_address(
            &[USER_COLLATERAL_SEED, market_key.as_ref(), owner.as_ref()],
            &crate::ID,
        )
        .0;
    }

    let buf_key = buf.key();
    let extra_accs = [
        CallbackAccount { pubkey: market_key, is_writable: false },
        CallbackAccount { pubkey: buf_key, is_writable: true },
        CallbackAccount { pubkey: pool_key, is_writable: true },
        CallbackAccount { pubkey: positions[0], is_writable: true },
        CallbackAccount { pubkey: positions[1], is_writable: true },
        CallbackAccount { pubkey: positions[2], is_writable: true },
        CallbackAccount { pubkey: positions[3], is_writable: true },
        CallbackAccount { pubkey: collaterals[0], is_writable: true },
        CallbackAccount { pubkey: collaterals[1], is_writable: true },
        CallbackAccount { pubkey: collaterals[2], is_writable: true },
        CallbackAccount { pubkey: collaterals[3], is_writable: true },
    ];

    // Flip the gate BEFORE queueing — so a callback retry or a fast re-call
    // cannot race a second queue_computation onto the same orders.
    buf.is_processing = true;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![MatchBatchOcCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &extra_accs,
        )?],
        1,
        0,
    )?;

    Ok(())
}
