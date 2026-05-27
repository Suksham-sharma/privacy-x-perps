// Pyth Pull Oracle reader.
//
// This module deliberately does NOT depend on `pyth-solana-receiver-sdk`.
// That crate's 1.x line pins `anchor-lang ^0.32.1`, and we're on Anchor
// 1.0.2 (Arcium constraint). The SDK won't compile. Instead we hand-roll
// the minimum `PriceUpdateV2` shape and Borsh-deserialize it ourselves.
// Layout sourced from pyth-solana-receiver-sdk v1.2.0 source.
//
// Owner check is the trust boundary: the account must be owned by the
// Pyth receiver program. We never accept an arbitrary Borsh blob.
//
// What we validate, in order:
//   1. account.owner == PYTH_RECEIVER_PROGRAM_ID
//   2. account.data discriminator matches PriceUpdateV2
//   3. verification_level == Full (no partial verification — see Codex
//      review notes; partial would weaken the trust model)
//   4. price_message.feed_id == market.pyth_feed_id (right asset)
//   5. publish_time within MAX_PRICE_AGE_SECS of clock.unix_timestamp
//   6. price > 0 (reject negative + zero — both indicate a broken feed)
//   7. conf / price <= MAX_PRICE_CONF_BPS / 10_000 (publishers agree)
//
// What we DON'T validate (v0 deferrals, documented):
//   - exponent normalization. We return the raw `price` mantissa. v0
//     assumes order prices, clearing prices, and Pyth prices all share the
//     same scale; the keeper is responsible for emitting orders in
//     Pyth's exponent (-8 for SOL/USD). Real exponent-aware scaling is
//     v0.2 work.
//   - ema_price / TWAP. We use the spot mantissa; perp matching wants
//     a recent point estimate, not a smoothed one.
//
use crate::{
    constants::{MAX_PRICE_AGE_SECS, MAX_PRICE_CONF_BPS, PYTH_RECEIVER_PROGRAM_ID},
    error::ErrorCode,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

// 8-byte Anchor discriminator for `PriceUpdateV2`. This is the first 8
// bytes of sha256("account:PriceUpdateV2"). Hardcoded so we don't depend
// on the SDK to compute it — and so a layout change upstream forces an
// explicit update here rather than silently accepting a different struct.
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

// Borsh-layout mirror of `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`.
// Field order MUST match the SDK exactly or deserialization parses the
// wrong bytes. See pyth-solana-receiver-sdk v1.2.0 src/price_update.rs.
#[derive(AnchorDeserialize)]
struct PriceUpdateV2 {
    pub _write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub _posted_slot: u64,
}

// Borsh enum: u8 variant index + variant data. Partial carries a u8;
// Full has no payload. Order must match the SDK enum declaration.
#[derive(AnchorDeserialize)]
enum VerificationLevel {
    Partial { _num_signatures: u8 },
    Full,
}

#[derive(AnchorDeserialize)]
struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub _exponent: i32,
    pub publish_time: i64,
    pub _prev_publish_time: i64,
    pub _ema_price: i64,
    pub _ema_conf: u64,
}

// Read + validate + return a Pyth price as a u64 mantissa. See module
// docstring for what's validated and what's deferred.
//
// The returned u64 is the raw `price_message.price` field (cast from
// i64 after the > 0 check). Callers in v0 use this directly as the
// "oracle_price" / "exit_price" in their internal units; exponent
// normalization is the keeper's responsibility in v0.
pub fn read_pyth_price(
    price_info: &AccountInfo,
    expected_feed_id: &[u8; 32],
    clock: &Clock,
) -> Result<u64> {
    // 1. Owner check — the trust anchor. Without this anyone can hand us
    //    a forged buffer with the right discriminator.
    require_keys_eq!(
        *price_info.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        ErrorCode::InvalidPythAccount
    );

    let data = price_info.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidPythAccount);

    // 2. Discriminator check — ensures it's actually a PriceUpdateV2,
    //    not (e.g.) a TwapUpdate that the receiver also owns.
    let disc = &data[..8];
    require!(
        disc == PRICE_UPDATE_V2_DISCRIMINATOR,
        ErrorCode::InvalidPythAccount
    );

    // Use the reader-style `deserialize` (not `try_from_slice`): real
    // on-chain PriceUpdateV2 accounts are 134 bytes total (the Borsh enum
    // tag for `Full` is 1 byte, but Pyth allocates space for the worst-case
    // `Partial` variant, leaving 1 trailing zero). `try_from_slice` errors
    // on trailing bytes; `deserialize` consumes just what each field needs.
    // Same code path then works for both our 133-byte localnet fixture and
    // a real cloned-from-devnet account.
    let mut cursor = &data[8..];
    let parsed = PriceUpdateV2::deserialize(&mut cursor)
        .map_err(|_| error!(ErrorCode::InvalidPythAccount))?;

    // 3. Reject partial verification. `get_price_no_older_than` in the
    //    real SDK enforces this too. Partial means fewer than 2/3 of
    //    Wormhole guardians signed — weakens the trust model substantially.
    require!(
        matches!(parsed.verification_level, VerificationLevel::Full),
        ErrorCode::PythVerificationInsufficient
    );

    // 4. Feed id — wrong-asset rejection. Caller is responsible for
    //    passing the right account; we verify they didn't (e.g.) hand us
    //    a BTC/USD feed when the market is SOL/USD.
    require!(
        &parsed.price_message.feed_id == expected_feed_id,
        ErrorCode::PythFeedIdMismatch
    );

    // 5. Freshness. publish_time is i64 (unix seconds); compare to
    //    clock.unix_timestamp with the freshness window. We allow
    //    future-dated publish_time (clock skew) but reject if it's
    //    further than MAX_PRICE_AGE_SECS in the past.
    let now = clock.unix_timestamp;
    let max_age = MAX_PRICE_AGE_SECS as i64;
    let age = now.saturating_sub(parsed.price_message.publish_time);
    require!(age <= max_age, ErrorCode::PythPriceStale);

    // 6. Positive price. Zero is a feed-init artifact; negative shouldn't
    //    happen but Pyth's type is signed so we have to check.
    require!(parsed.price_message.price > 0, ErrorCode::PythPriceInvalid);
    let price_u64 = parsed.price_message.price as u64;

    // 7. Confidence guardrail. Reject if conf is more than
    //    MAX_PRICE_CONF_BPS basis points of the price. Using u128 to
    //    avoid overflow on `conf * 10_000`.
    let conf_bps = (parsed.price_message.conf as u128)
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(price_u64 as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        conf_bps <= MAX_PRICE_CONF_BPS as u128,
        ErrorCode::PythConfidenceTooWide
    );

    Ok(price_u64)
}
