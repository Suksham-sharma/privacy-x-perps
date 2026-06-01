pub mod constants;
pub mod error;
pub mod instructions;
pub mod pyth;
pub mod state;

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
pub use constants::*;
pub use instructions::*;
#[allow(unused_imports)]
pub use state::*;

declare_id!("EhTFnsoyZp9aRYoZrFPVPtokiRLwjxvAgZAuEQG8yZgF");

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

    pub fn init_market(
        ctx: Context<InitMarket>,
        pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        init_market::init_market_handler(ctx, pyth_feed_id)
    }

    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        x25519_pubkey: [u8; 32],
        nonce: u128,
        max_margin: u64,
        ct_side: [u8; 32],
        ct_price: [u8; 32],
        ct_size: [u8; 32],
        ct_client_nonce: [u8; 32],
    ) -> Result<()> {
        submit_order::submit_order_handler(
            ctx,
            x25519_pubkey,
            nonce,
            max_margin,
            ct_side,
            ct_price,
            ct_size,
            ct_client_nonce,
        )
    }

    pub fn init_match_batch_comp_def(ctx: Context<InitMatchBatchCompDef>) -> Result<()> {
        match_batch::init_match_batch_comp_def_handler(ctx)
    }

    pub fn process_batch(
        ctx: Context<ProcessBatch>,
        computation_offset: u64,
    ) -> Result<()> {
        process_batch::process_batch_handler(ctx, computation_offset)
    }

    #[arcium_callback(encrypted_ix = "match_batch_oc")]
    pub fn match_batch_oc_callback(
        ctx: Context<MatchBatchOcCallback>,
        output: SignedComputationOutputs<MatchBatchOcOutput>,
    ) -> Result<()> {
        match_batch::match_batch_callback_handler(ctx, output)
    }

    pub fn init_pool(ctx: Context<InitPool>, amount: u64) -> Result<()> {
        init_pool::init_pool_handler(ctx, amount)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit::deposit_handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        withdraw::withdraw_handler(ctx, amount)
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        cancel_order::cancel_order_handler(ctx)
    }

    // Permissionless recovery: reset a wedged BatchBuffer (is_processing stuck
    // true because a dropped Arcium computation's callback never fired) after
    // EXPIRE_BATCH_SLOTS. Unbricks the market without waiting on the callback.
    pub fn expire_batch(ctx: Context<ExpireBatch>) -> Result<()> {
        expire_batch::expire_batch_handler(ctx)
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        close_position::close_position_handler(ctx)
    }

    pub fn liquidate_position(ctx: Context<LiquidatePosition>) -> Result<()> {
        liquidate_position::liquidate_position_handler(ctx)
    }

    // DEMO/LOCALNET ONLY (feature = "mock-oracle"): a localnet crank calls this
    // to push a live SOL/USD price into the program-owned mock PriceUpdateV2.
    #[cfg(feature = "mock-oracle")]
    pub fn set_mock_oracle(ctx: Context<SetMockOracle>, price: i64) -> Result<()> {
        set_mock_oracle::set_mock_oracle_handler(ctx, price)
    }
}
