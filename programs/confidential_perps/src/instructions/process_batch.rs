// process_batch — closes the open batch window and queues match_batch in
// Arcium. Permissionless: anyone can trigger once the gates pass (n_orders == 2,
// window closed, not already in flight); pays Arcium fees via `payer`.
//
// v0 handles exactly 2 orders per batch (circuit-imposed); 1-order / 0-order /
// timeout-refund flows are v0.2.
use crate::{
    constants::{
        BATCH_BUFFER_SEED, COMP_DEF_OFFSET_MATCH_BATCH, MARKET_SEED, POSITION_SEED,
        USER_COLLATERAL_SEED,
    },
    error::ErrorCode,
    instructions::match_batch::MatchBatchCallback,
    state::{BatchBuffer, Market},
    ArciumSignerAccount,
    ID,
    ID_CONST,
};
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

#[queue_computation_accounts("match_batch", payer)]
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
    let buf = &mut ctx.accounts.batch_buffer;
    let market = &ctx.accounts.market;

    // Read the oracle price BEFORE any state mutation; if Pyth's stale or
    // mismatched, we fail closed and the batch stays open for retry.
    let oracle_price = crate::pyth::read_pyth_price(
        &ctx.accounts.price_update.to_account_info(),
        &market.pyth_feed_id,
        &Clock::get()?,
    )?;

    require!(!buf.is_processing, ErrorCode::BatchAlreadyProcessing);
    // v0: exactly 2 orders — the circuit has fixed arity (see
    // encrypted-ixs/src/lib.rs match_batch).
    require!(buf.n_orders == 2, ErrorCode::BatchNotReady);

    let now_slot = Clock::get()?.slot;
    let closes_at = buf
        .opened_at_slot
        .checked_add(market.batch_window_slots)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(now_slot >= closes_at, ErrorCode::BatchWindowOpen);

    // Required by the queue_computation_accounts macro pattern.
    ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

    let a = buf.orders[0];
    let b = buf.orders[1];

    // Build the circuit args. Each Enc<Shared, Order> is one pubkey + one
    // nonce + the field ciphertexts in struct order (side u8, price u64,
    // size u64, client_nonce u64 — matches encrypted-ixs Order).
    let args = ArgBuilder::new()
        // Order A
        .x25519_pubkey(a.x25519_pubkey)
        .plaintext_u128(a.nonce)
        .encrypted_u8(a.ct_side)
        .encrypted_u64(a.ct_price)
        .encrypted_u64(a.ct_size)
        .encrypted_u64(a.ct_client_nonce)
        // Order B
        .x25519_pubkey(b.x25519_pubkey)
        .plaintext_u128(b.nonce)
        .encrypted_u8(b.ct_side)
        .encrypted_u64(b.ct_price)
        .encrypted_u64(b.ct_size)
        .encrypted_u64(b.ct_client_nonce)
        // Public oracle price
        .plaintext_u64(oracle_price)
        .build();

    // Derive the 6 extra accounts the callback needs, in the order its
    // Accounts struct expects (see MatchBatchCallback doc comment).
    let market_key = market.key();
    let (position_a, _) = Pubkey::find_program_address(
        &[POSITION_SEED, market_key.as_ref(), a.owner.as_ref()],
        &crate::ID,
    );
    let (position_b, _) = Pubkey::find_program_address(
        &[POSITION_SEED, market_key.as_ref(), b.owner.as_ref()],
        &crate::ID,
    );
    let (uc_a, _) = Pubkey::find_program_address(
        &[USER_COLLATERAL_SEED, market_key.as_ref(), a.owner.as_ref()],
        &crate::ID,
    );
    let (uc_b, _) = Pubkey::find_program_address(
        &[USER_COLLATERAL_SEED, market_key.as_ref(), b.owner.as_ref()],
        &crate::ID,
    );

    let extra_accs = [
        CallbackAccount { pubkey: market_key, is_writable: false },
        CallbackAccount { pubkey: buf.key(), is_writable: true },
        CallbackAccount { pubkey: position_a, is_writable: true },
        CallbackAccount { pubkey: position_b, is_writable: true },
        CallbackAccount { pubkey: uc_a, is_writable: true },
        CallbackAccount { pubkey: uc_b, is_writable: true },
    ];

    // Flip the gate BEFORE queueing — so a callback retry or a fast
    // re-call cannot race a second queue_computation onto the same orders.
    buf.is_processing = true;

    queue_computation(
        ctx.accounts,
        computation_offset,
        args,
        vec![MatchBatchCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &extra_accs,
        )?],
        1,
        0,
    )?;

    Ok(())
}
