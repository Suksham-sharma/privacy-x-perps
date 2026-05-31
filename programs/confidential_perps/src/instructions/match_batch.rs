// match_batch Anchor side (v0a) — comp def init + callback; process_batch.rs queues it.
use crate::{
    constants::{
        BATCH_BUFFER_SEED, COMP_DEF_OFFSET_MATCH_BATCH, MARKET_SEED, MAX_ORDERS, POOL_SEED,
        POSITION_SEED, USER_COLLATERAL_SEED,
    },
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market, Pool, Position, UserCollateral},
    ID,
    ID_CONST,
};
use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;

#[init_computation_definition_accounts("match_batch", payer)]
#[derive(Accounts)]
pub struct InitMatchBatchCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: created by `init_computation_def` in this handler — pre-init it
    /// has no discriminator, so Account<T> can't validate it. The
    /// #[init_computation_definition_accounts] macro generates the PDA + owner
    /// constraints that make this safe.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot)
    )]
    /// CHECK: Solana Address Lookup Table, owned by the LUT program. Address
    /// pinned to derive_mxe_lut_pda above (our MXE's canonical LUT); the arcium
    /// program verifies its contents during computation queuing.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: Address Lookup Table program, pinned to LUT_PROGRAM_ID. Used only
    /// as the CPI target for LUT modifications in `init_computation_def`.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn init_match_batch_comp_def_handler(ctx: Context<InitMatchBatchCompDef>) -> Result<()> {
    init_computation_def(ctx.accounts, None)?;
    Ok(())
}

// Callback — wires the public BatchOutput back into on-chain state. extra_accs
// order MUST match process_batch: [market, batch_buffer, pool, position_0..3,
// user_collateral_0..3]. position_i/user_collateral_i derive against
// batch_buffer.orders[i].owner, so the buffer is reset HERE (after fills), not in
// process_batch, else derivation drifts; slots >= n_orders are market-key padding
// and IGNORED. Positions+collaterals are UncheckedAccount (validated manually):
// typed accounts can't validate padding slots and 8 Box<Account> blow the SBF stack.

#[callback_accounts("match_batch")]
#[derive(Accounts)]
pub struct MatchBatchCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(
        address = derive_comp_def_pda!(COMP_DEF_OFFSET_MATCH_BATCH)
    )]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(
        address = derive_mxe_pda!()
    )]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: verified by the arcium program via `validate_callback_ixs`
    /// (injected by #[arcium_callback]) against the instructions sysvar.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: pinned to the Solana instructions sysvar id (constraint above);
    /// read-only inside validate_callback_ixs.
    pub instructions_sysvar: UncheckedAccount<'info>,

    // extra_accs — passed by process_batch's callback_ix call (same order).

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

    #[account(
        mut,
        seeds = [POOL_SEED, market.key().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: PDA + owner + discriminator validated in the handler via
    /// `apply_fill_unchecked` (only for slots < n_orders that filled); `mut`
    /// sets the writable bit.
    #[account(mut)]
    pub position_0: UncheckedAccount<'info>,
    /// CHECK: see position_0.
    #[account(mut)]
    pub position_1: UncheckedAccount<'info>,
    /// CHECK: see position_0.
    #[account(mut)]
    pub position_2: UncheckedAccount<'info>,
    /// CHECK: see position_0.
    #[account(mut)]
    pub position_3: UncheckedAccount<'info>,

    /// CHECK: PDA + owner + discriminator validated in the handler via
    /// `credit_refund` (only for slots < n_orders that filled 0); `mut` sets
    /// the writable bit.
    #[account(mut)]
    pub user_collateral_0: UncheckedAccount<'info>,
    /// CHECK: see user_collateral_0.
    #[account(mut)]
    pub user_collateral_1: UncheckedAccount<'info>,
    /// CHECK: see user_collateral_0.
    #[account(mut)]
    pub user_collateral_2: UncheckedAccount<'info>,
    /// CHECK: see user_collateral_0.
    #[account(mut)]
    pub user_collateral_3: UncheckedAccount<'info>,
}

#[event]
pub struct BatchSettledEvent {
    pub batch_id: u64,
    pub clearing_price: u64,
    pub total_long_base: u64,    // gross long lots filled this batch
    pub total_short_base: u64,   // gross short lots filled this batch
    pub pool_base: i64,          // pool's aggregate net base AFTER this batch
    pub filled_owners: Vec<Pubkey>, // owners whose order filled (size > 0)
}

pub fn match_batch_callback_handler(
    ctx: Context<MatchBatchCallback>,
    output: SignedComputationOutputs<MatchBatchOutput>,
) -> Result<()> {
    let o = match output.verify_output(
        &ctx.accounts.cluster_account,
        &ctx.accounts.computation_account,
    ) {
        Ok(MatchBatchOutput { field_0 }) => field_0,
        Err(_) => return Err(ErrorCode::AbortedComputation.into()),
    };

    // Field order matches encrypted-ixs BatchOutput: f0 clearing_price, f1/f2
    // long/short_base, then f3..f10 = (size,side) pairs for slots 0..3.
    let clearing_price = o.field_0;
    let total_long = o.field_1;
    let total_short = o.field_2;
    let fill_sizes = [o.field_3, o.field_5, o.field_7, o.field_9];
    let fill_sides = [o.field_4, o.field_6, o.field_8, o.field_10];

    let market_key = ctx.accounts.market.key();

    // Snapshot per-order routing data before the buffer reset zeroes orders[].
    let (batch_id, n, owners, margins) = {
        let buf = &ctx.accounts.batch_buffer;
        let n = buf.n_orders as usize;
        let mut owners = [Pubkey::default(); MAX_ORDERS];
        let mut margins = [0u64; MAX_ORDERS];
        for i in 0..n {
            owners[i] = buf.orders[i].owner;
            margins[i] = buf.orders[i].max_margin;
        }
        (buf.batch_id, n, owners, margins)
    };

    let position_infos = [
        ctx.accounts.position_0.to_account_info(),
        ctx.accounts.position_1.to_account_info(),
        ctx.accounts.position_2.to_account_info(),
        ctx.accounts.position_3.to_account_info(),
    ];
    let uc_infos = [
        ctx.accounts.user_collateral_0.to_account_info(),
        ctx.accounts.user_collateral_1.to_account_info(),
        ctx.accounts.user_collateral_2.to_account_info(),
        ctx.accounts.user_collateral_3.to_account_info(),
    ];

    // Apply each real order: filled => update Position (margin stays locked);
    // fill 0 (didn't cross) => refund locked margin. No order is ever stuck.
    let mut filled_owners: Vec<Pubkey> = Vec::new();
    for i in 0..n {
        if fill_sizes[i] == 0 {
            credit_refund(&uc_infos[i], &market_key, &owners[i], margins[i])?;
        } else {
            apply_fill_unchecked(
                &position_infos[i],
                &market_key,
                &owners[i],
                fill_sizes[i],
                fill_sides[i],
                clearing_price,
                margins[i],
            )?;
            filled_owners.push(owners[i]);
        }
    }

    // The pool absorbs the net imbalance at the clearing (oracle) price. When
    // the two sides matched exactly it's a no-op (pure peer-to-peer).
    let pool = &mut ctx.accounts.pool;
    apply_pool(pool, total_long, total_short, clearing_price)?;
    let pool_base = pool.base_amount_lots;

    emit!(BatchSettledEvent {
        batch_id,
        clearing_price,
        total_long_base: total_long,
        total_short_base: total_short,
        pool_base,
        filled_owners,
    });

    // Reset the buffer for the next batch.
    let buf = &mut ctx.accounts.batch_buffer;
    buf.n_orders = 0;
    buf.opened_at_slot = 0;
    buf.orders = [EncryptedOrderSlot::default(); MAX_ORDERS];
    buf.batch_id = batch_id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;
    buf.is_processing = false;

    Ok(())
}

// Manual UserCollateral refund (zero-fill). Validates: program-owned, address ==
// canonical PDA for (market,owner), discriminator + owner field; then credits amount.
fn credit_refund(
    uc_info: &AccountInfo<'_>,
    market_key: &Pubkey,
    expected_owner: &Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_keys_eq!(*uc_info.owner, crate::ID, ErrorCode::InvalidCallback);
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[USER_COLLATERAL_SEED, market_key.as_ref(), expected_owner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(uc_info.key(), expected_pda, ErrorCode::InvalidCallback);

    let mut data = uc_info.try_borrow_mut_data()?;
    let mut uc = UserCollateral::try_deserialize(&mut data.as_ref())?;
    require_keys_eq!(uc.owner, *expected_owner, ErrorCode::InvalidCallback);
    uc.balance = uc.balance.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
    let mut cursor: &mut [u8] = &mut data[..];
    uc.try_serialize(&mut cursor)?;
    Ok(())
}

// Manual Position fill. Same validation discipline as credit_refund, then applies
// the delta: long (side=0) +base/-quote, short (side=1) -base/+quote (i128);
// max_margin accumulates into margin_locked, released at close with realized PnL.
fn apply_fill_unchecked(
    pos_info: &AccountInfo<'_>,
    market_key: &Pubkey,
    expected_owner: &Pubkey,
    fill_size: u64,
    side: u8,
    clearing_price: u64,
    max_margin: u64,
) -> Result<()> {
    require!(side <= 1, ErrorCode::InvalidComputation);
    require_keys_eq!(*pos_info.owner, crate::ID, ErrorCode::InvalidCallback);
    let (expected_pda, _bump) = Pubkey::find_program_address(
        &[POSITION_SEED, market_key.as_ref(), expected_owner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(pos_info.key(), expected_pda, ErrorCode::InvalidCallback);

    let mut data = pos_info.try_borrow_mut_data()?;
    let mut pos = Position::try_deserialize(&mut data.as_ref())?;
    require_keys_eq!(pos.owner, *expected_owner, ErrorCode::InvalidCallback);

    let size = fill_size as i128;
    let cost = (fill_size as u128)
        .checked_mul(clearing_price as u128)
        .ok_or(ErrorCode::MathOverflow)? as i128;
    let (delta_base, delta_quote) = if side == 0 { (size, -cost) } else { (-size, cost) };

    let new_base = (pos.base_amount_lots as i128)
        .checked_add(delta_base)
        .ok_or(ErrorCode::MathOverflow)?;
    pos.base_amount_lots = i64::try_from(new_base).map_err(|_| ErrorCode::MathOverflow)?;
    pos.quote_entry = pos
        .quote_entry
        .checked_add(delta_quote)
        .ok_or(ErrorCode::MathOverflow)?;
    pos.margin_locked = pos
        .margin_locked
        .checked_add(max_margin)
        .ok_or(ErrorCode::MathOverflow)?;

    let mut cursor: &mut [u8] = &mut data[..];
    pos.try_serialize(&mut cursor)?;
    Ok(())
}

// Pool takes the OPPOSITE of traders' net base at clearing price: net long =>
// pool short (base-=d, quote+=d*price); net short => pool long; balanced => untouched.
fn apply_pool(pool: &mut Pool, total_long: u64, total_short: u64, clearing_price: u64) -> Result<()> {
    let long = total_long as i128;
    let short = total_short as i128;
    if long == short {
        return Ok(());
    }

    let d = (long - short).unsigned_abs(); // net magnitude
    let cost = (d as u128)
        .checked_mul(clearing_price as u128)
        .ok_or(ErrorCode::MathOverflow)? as i128;
    let d = d as i128;

    let (delta_base, delta_quote) = if long > short {
        (-d, cost) // pool short the excess longs
    } else {
        (d, -cost) // pool long the excess shorts
    };

    let new_base = (pool.base_amount_lots as i128)
        .checked_add(delta_base)
        .ok_or(ErrorCode::MathOverflow)?;
    pool.base_amount_lots = i64::try_from(new_base).map_err(|_| ErrorCode::MathOverflow)?;
    pool.quote_entry = pool
        .quote_entry
        .checked_add(delta_quote)
        .ok_or(ErrorCode::MathOverflow)?;
    Ok(())
}
