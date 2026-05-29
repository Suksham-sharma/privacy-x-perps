use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid computation")]
    InvalidComputation,
    #[msg("Invalid callback")]
    InvalidCallback,
    #[msg("Custom error message")]
    CustomError,
    #[msg("The computation was aborted")]
    AbortedComputation,

    #[msg("Batch buffer is full")]
    BatchFull,
    #[msg("Batch window has closed")]
    BatchWindowClosed,
    #[msg("Batch window has not yet closed")]
    BatchWindowOpen,
    #[msg("Batch is empty")]
    BatchEmpty,
    #[msg("Batch is not ready to process (v0 requires exactly 2 orders)")]
    BatchNotReady,
    #[msg("Batch is already being processed (computation in flight)")]
    BatchAlreadyProcessing,
    #[msg("No open position to close")]
    NoOpenPosition,
    #[msg("Position is underwater; cannot self-close (liquidation required)")]
    PositionUnderwater,
    #[msg("Position is healthy; not eligible for liquidation")]
    PositionNotLiquidatable,
    #[msg("Cannot liquidate your own position")]
    SelfLiquidationNotAllowed,
    #[msg("Market is already initialized")]
    MarketAlreadyInitialized,
    #[msg("Invalid Pyth feed")]
    InvalidPythFeed,
    #[msg("Pyth account is not owned by the receiver program or has bad data")]
    InvalidPythAccount,
    #[msg("Pyth price update is not fully verified (Wormhole 2/3 threshold)")]
    PythVerificationInsufficient,
    #[msg("Pyth account is for a different asset than the market expects")]
    PythFeedIdMismatch,
    #[msg("Pyth price is stale beyond MAX_PRICE_AGE_SECS")]
    PythPriceStale,
    #[msg("Pyth reported a non-positive price")]
    PythPriceInvalid,
    #[msg("Pyth confidence interval exceeds MAX_PRICE_CONF_BPS of price")]
    PythConfidenceTooWide,
    #[msg("Insufficient collateral balance")]
    InsufficientCollateral,
    #[msg("Withdrawal would exceed per-slot rate limit (5% of vault)")]
    WithdrawRateLimitExceeded,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
}
