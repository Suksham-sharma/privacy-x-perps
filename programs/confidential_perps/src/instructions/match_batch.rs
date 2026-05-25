// match_batch Anchor side — comp def init for now. process_batch + callback
// come in follow-up commits.
use crate::ID;
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
