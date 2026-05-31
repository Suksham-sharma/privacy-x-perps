// DEMO/LOCALNET ONLY (feature = "mock-oracle").
//
// A bare validator has no Pyth publisher/Wormhole network, so the cloned
// PriceUpdateV2 account never updates. This instruction lets a localnet crank
// write a fresh SOL/USD price into a PROGRAM-OWNED account that mimics the Pyth
// PriceUpdateV2 layout byte-for-byte. Paired with the feature-gated owner-check
// relaxation in pyth.rs, the rest of read_pyth_price (discriminator, Full
// verification, feed_id, freshness, conf) validates it exactly like a real Pyth
// account — so the engine reads a live, ticking price with no other changes.
//
// SECURITY: stripped from `default` features before any devnet/mainnet build.
use crate::constants::{MOCK_ORACLE_SEED, SOL_USD_FEED_ID};
use crate::error::ErrorCode;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Same 8-byte discriminator read_pyth_price checks (sha256("account:PriceUpdateV2")).
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

// PriceUpdateV2 (Full variant) byte length — mirrors scripts/build-pyth-fixture.mjs:
// 8 disc + 32 write_authority + 1 verification + 32 feed_id + 8 price + 8 conf
// + 4 exponent + 8 publish_time + 8 prev_publish_time + 8 ema_price + 8 ema_conf
// + 8 posted_slot.
const MOCK_ORACLE_SPACE: usize = 133;

#[derive(Accounts)]
pub struct SetMockOracle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: SAFETY — intentionally untyped. This account holds a raw Pyth
    /// PriceUpdateV2 byte layout (with Pyth's own 8-byte discriminator); a typed
    /// `Account<T>` would impose Anchor's discriminator and reject it. Invariants
    /// are enforced without the type: the address is pinned by the PDA
    /// `seeds = [MOCK_ORACLE_SEED]` + canonical `bump` (only this program can
    /// create/own it), and every consumer re-validates the bytes through
    /// `read_pyth_price` (discriminator, Full verification, feed_id, freshness,
    /// conf) before trusting the price. Created on first call, overwritten after.
    #[account(mut, seeds = [MOCK_ORACLE_SEED], bump)]
    pub mock_oracle: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn set_mock_oracle_handler(ctx: Context<SetMockOracle>, price: i64) -> Result<()> {
    require!(price > 0, ErrorCode::PythPriceInvalid);

    let clock = Clock::get()?;
    let oracle_ai = ctx.accounts.mock_oracle.to_account_info();

    // Create the program-owned PDA on first push.
    if oracle_ai.data_is_empty() {
        let lamports = Rent::get()?.minimum_balance(MOCK_ORACLE_SPACE);
        let bump = ctx.bumps.mock_oracle;
        let signer_seeds: &[&[u8]] = &[MOCK_ORACLE_SEED, core::slice::from_ref(&bump)];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::CreateAccount {
                    from: ctx.accounts.authority.to_account_info(),
                    to: oracle_ai.clone(),
                },
                &[signer_seeds],
            ),
            lamports,
            MOCK_ORACLE_SPACE as u64,
            &crate::ID,
        )?;
    }

    // Write the PriceUpdateV2 (Full) layout in the exact Borsh field order
    // read_pyth_price expects. publish_time = now so the freshness check passes
    // even on the strict 30s window.
    let mut data = oracle_ai.try_borrow_mut_data()?;
    require!(data.len() >= MOCK_ORACLE_SPACE, ErrorCode::InvalidPythAccount);

    data[0..8].copy_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
    data[8..40].fill(0); // write_authority — never validated
    data[40] = 1; // verification_level = Full
    data[41..73].copy_from_slice(&SOL_USD_FEED_ID);
    data[73..81].copy_from_slice(&price.to_le_bytes()); // price (raw mantissa, exp 0 in v0)
    data[81..89].copy_from_slice(&0u64.to_le_bytes()); // conf = 0 (well under MAX_PRICE_CONF_BPS)
    data[89..93].copy_from_slice(&0i32.to_le_bytes()); // exponent
    data[93..101].copy_from_slice(&clock.unix_timestamp.to_le_bytes()); // publish_time
    data[101..109].copy_from_slice(&clock.unix_timestamp.to_le_bytes()); // prev_publish_time
    data[109..117].copy_from_slice(&price.to_le_bytes()); // ema_price
    data[117..125].copy_from_slice(&0u64.to_le_bytes()); // ema_conf
    data[125..133].copy_from_slice(&clock.slot.to_le_bytes()); // posted_slot

    Ok(())
}
