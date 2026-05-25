// match_batch Anchor side — comp def init + callback. The `process_batch`
// queue-handler (task #17) is a follow-up; until it lands, the callback is
// reachable code but unfired.
use crate::{
    constants::{
        BATCH_BUFFER_SEED, COMP_DEF_OFFSET_MATCH_BATCH, MARKET_SEED, POSITION_SEED,
        USER_COLLATERAL_SEED,
    },
    error::ErrorCode,
    state::{BatchBuffer, EncryptedOrderSlot, Market, Position, UserCollateral},
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
    /// CHECK: SAFETY — comp_def_account is created by `init_computation_def`
    /// inside this handler. Pre-init it has no discriminator, so Account<T>
    /// cannot validate it. After init, the arcium program enforces the
    /// canonical PDA derivation (program_id + comp def offset) and owner.
    /// The macro `#[init_computation_definition_accounts("match_batch", payer)]`
    /// generates the constraints that make this safe.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(
        mut,
        address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot)
    )]
    /// CHECK: SAFETY — Solana Address Lookup Table account. Owned by the
    /// LUT program (not us). Address pinned to derive_mxe_lut_pda(...) above,
    /// which is the canonical LUT for our MXE; the arcium program verifies
    /// the LUT contents during computation queuing.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: SAFETY — Address Lookup Table program. Address pinned to the
    /// constant LUT_PROGRAM_ID. Used only as the CPI target for LUT
    /// modifications inside `init_computation_def`.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

pub fn init_match_batch_comp_def_handler(ctx: Context<InitMatchBatchCompDef>) -> Result<()> {
    init_computation_def(ctx.accounts, None)?;
    Ok(())
}

// ---------- callback ----------
//
// Wires the public BatchOutput from the MPC back into on-chain state.
//
// Account contract (must match what process_batch passes via callback_ix's
// extra_accs slice — preserved in this order):
//   [market, batch_buffer, position_a, position_b,
//    user_collateral_a, user_collateral_b]
//
// position_*/user_collateral_* PDAs are all derived against
// batch_buffer.orders[0/1].owner. process_batch (task #17) MUST snapshot or
// lock orders[0..2] so they stay readable here — otherwise the PDA derivation
// drifts and Anchor's seeds check fails. The simplest impl: don't reset
// BatchBuffer in process_batch; reset it here in the callback after fills
// land.

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
    /// CHECK: SAFETY — computation_account is verified by the arcium program
    /// via `validate_callback_ixs` (injected by the `#[arcium_callback]`
    /// macro) which checks the instructions sysvar against the expected
    /// callback discriminator + program id.
    pub computation_account: UncheckedAccount<'info>,
    #[account(
        address = derive_cluster_pda!(mxe_account)
    )]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: SAFETY — pinned to the Solana instructions sysvar id via the
    /// account constraint above. Read-only inside validate_callback_ixs.
    pub instructions_sysvar: UncheckedAccount<'info>,

    // -- extra_accs (passed by process_batch's callback_ix call) --

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
        seeds = [POSITION_SEED, market.key().as_ref(), batch_buffer.orders[0].owner.as_ref()],
        bump = position_a.bump,
    )]
    pub position_a: Box<Account<'info, Position>>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), batch_buffer.orders[1].owner.as_ref()],
        bump = position_b.bump,
    )]
    pub position_b: Box<Account<'info, Position>>,

    // UserCollateral PDAs are validated + deserialized MANUALLY in the
    // handler (see `credit_refund`). Adding two more typed `Box<Account<...>>`
    // here pushed Anchor's generated `try_accounts` past the BPF stack budget
    // (linker emits "overwrites values in the frame" / "may cause undefined
    // behavior"). Since the refund only fires on NoMatch, paying the
    // validation cost only on that branch is also a CU win on the happy path.
    /// CHECK: PDA derivation + owner + discriminator validated in handler
    /// via `credit_refund`. `mut` here only sets the writable bit.
    #[account(mut)]
    pub user_collateral_a: UncheckedAccount<'info>,
    /// CHECK: same as user_collateral_a.
    #[account(mut)]
    pub user_collateral_b: UncheckedAccount<'info>,
}

#[event]
pub struct BatchSettledEvent {
    pub batch_id: u64,
    pub clearing_price: u64,
    pub total_volume: u64,
    pub owner_a: Pubkey,
    pub owner_b: Pubkey,
}

#[event]
pub struct NoMatchEvent {
    pub batch_id: u64,
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

    // Field order matches encrypted-ixs BatchOutput:
    //   field_0 clearing_price, field_1 total_volume,
    //   field_2 fill_a_size,    field_3 fill_a_side,
    //   field_4 fill_b_size,    field_5 fill_b_side.
    let clearing_price = o.field_0;
    let total_volume = o.field_1;
    let fill_a_size = o.field_2;
    let fill_a_side = o.field_3;
    let fill_b_size = o.field_4;
    let fill_b_side = o.field_5;

    let market_key = ctx.accounts.market.key();
    let buf = &mut ctx.accounts.batch_buffer;
    let batch_id = buf.batch_id;
    let owner_a = buf.orders[0].owner;
    let owner_b = buf.orders[1].owner;
    // Snapshot max_margins before the buffer reset below zeroes orders[].
    let max_margin_a = buf.orders[0].max_margin;
    let max_margin_b = buf.orders[1].max_margin;

    if clearing_price == 0 {
        // No-match: refund both locked margins. On match, max_margin stays
        // locked as the position's backing collateral (v0 doesn't refund
        // partial-fill excess — would leak order size; see EncryptedOrderSlot
        // doc comment).
        credit_refund(
            &ctx.accounts.user_collateral_a,
            &market_key,
            &owner_a,
            max_margin_a,
        )?;
        credit_refund(
            &ctx.accounts.user_collateral_b,
            &market_key,
            &owner_b,
            max_margin_b,
        )?;
        emit!(NoMatchEvent { batch_id });
    } else {
        apply_fill(&mut ctx.accounts.position_a, fill_a_size, fill_a_side, clearing_price)?;
        apply_fill(&mut ctx.accounts.position_b, fill_b_size, fill_b_side, clearing_price)?;

        emit!(BatchSettledEvent {
            batch_id,
            clearing_price,
            total_volume,
            owner_a,
            owner_b,
        });
    }

    // Reset the buffer for the next batch in either case.
    buf.n_orders = 0;
    buf.opened_at_slot = 0;
    buf.orders = [EncryptedOrderSlot::default(); crate::constants::MAX_ORDERS];
    buf.batch_id = batch_id.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}

// Manual UserCollateral refund — see the doc comment on user_collateral_a in
// MatchBatchCallback for why this isn't a typed Anchor account. Validates:
//   1. account is owned by our program (rejects spoofed accounts),
//   2. its address matches the canonical PDA for (market, expected_owner),
//   3. its discriminator + deserialized `owner` field match.
// Then mutates `balance` in place and re-serializes.
fn credit_refund(
    uc_info: &UncheckedAccount<'_>,
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
    uc.balance = uc
        .balance
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    let mut cursor: &mut [u8] = &mut data[..];
    uc.try_serialize(&mut cursor)?;
    Ok(())
}

// Apply a single fill to a Position. Long (side=0) adds base + pays quote;
// short (side=1) subtracts base + receives quote. Both deltas widen to i128
// before the checked op so a max-size fill at max price can't trip overflow.
fn apply_fill(pos: &mut Position, fill_size: u64, side: u8, clearing_price: u64) -> Result<()> {
    if fill_size == 0 {
        return Ok(());
    }
    require!(side <= 1, ErrorCode::InvalidComputation);

    let size = fill_size as i128;
    let cost = (fill_size as u128)
        .checked_mul(clearing_price as u128)
        .ok_or(ErrorCode::MathOverflow)? as i128;

    let (delta_base, delta_quote) = if side == 0 {
        (size, -cost)
    } else {
        (-size, cost)
    };

    let new_base = (pos.base_amount_lots as i128)
        .checked_add(delta_base)
        .ok_or(ErrorCode::MathOverflow)?;
    pos.base_amount_lots = i64::try_from(new_base).map_err(|_| ErrorCode::MathOverflow)?;

    pos.quote_entry = pos
        .quote_entry
        .checked_add(delta_quote)
        .ok_or(ErrorCode::MathOverflow)?;

    Ok(())
}
