pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
pub use constants::*;
pub use instructions::*;
#[allow(unused_imports)]
pub use state::*;

declare_id!("4SRWjriSqi6h3ec7peAFkHFdELpHw84gKSXKs14Q9ErG");

#[arcium_program]
pub mod confidential_perps {
    use super::*;

    pub fn init_add_together_comp_def(ctx: Context<InitAddTogetherCompDef>) -> Result<()> {
        add_together::init_add_together_comp_def_handler(ctx)
    }

    pub fn add_together(
        ctx: Context<AddTogether>,
        computation_offset: u64,
        ciphertext_0: [u8; 32],
        ciphertext_1: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        add_together::add_together_handler(ctx, computation_offset, ciphertext_0, ciphertext_1, pub_key, nonce)
    }

    #[arcium_callback(encrypted_ix = "add_together")]
    pub fn add_together_callback(
        ctx: Context<AddTogetherCallback>,
        output: SignedComputationOutputs<AddTogetherOutput>,
    ) -> Result<()> {
        add_together::add_together_callback_handler(ctx, output)
    }

    // -- SOL-PERP matching --

    pub fn init_market(ctx: Context<InitMarket>) -> Result<()> {
        init_market::init_market_handler(ctx)
    }

    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        x25519_pubkey: [u8; 32],
        nonce: u128,
        ct_side: [u8; 32],
        ct_price: [u8; 32],
        ct_size: [u8; 32],
        ct_client_nonce: [u8; 32],
    ) -> Result<()> {
        submit_order::submit_order_handler(
            ctx, x25519_pubkey, nonce, ct_side, ct_price, ct_size, ct_client_nonce,
        )
    }

    // -- collateral --

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit::deposit_handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        withdraw::withdraw_handler(ctx, amount)
    }
}
