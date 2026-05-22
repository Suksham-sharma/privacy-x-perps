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

    // -- domain errors --
    #[msg("Batch buffer is full")]
    BatchFull,
    #[msg("Batch window has closed")]
    BatchWindowClosed,
    #[msg("Batch window has not yet closed")]
    BatchWindowOpen,
    #[msg("Batch is empty")]
    BatchEmpty,
    #[msg("Market is already initialized")]
    MarketAlreadyInitialized,
    #[msg("Invalid Pyth feed")]
    InvalidPythFeed,
}
