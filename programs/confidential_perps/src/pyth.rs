// Pyth Pull Oracle reader. Hand-rolls PriceUpdateV2 (Borsh, layout from sdk
// v1.2.0) because the SDK pins anchor ^0.32.1 vs Arcium's 1.0.2. TRUST BOUNDARY
// is the owner check (must be Pyth receiver-owned; never an arbitrary blob);
// validates in order: owner, discriminator, Full verification (no Partial),
// feed_id, freshness, price>0, conf. Returns the price NORMALIZED to the
// protocol's internal fixed-point (USD * 1e6 = USDC base units per SOL) using
// the on-chain exponent, so a feed at any exponent (devnet SOL/USD is -8) reads
// in the same units the matching circuit and orders use. Deferred to v0.2: ema/TWAP.
use crate::{
    constants::{
        INTERNAL_PRICE_DECIMALS, MAX_PRICE_AGE_SECS, MAX_PRICE_CONF_BPS, PYTH_RECEIVER_PROGRAM_ID,
    },
    error::ErrorCode,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

// 8-byte discriminator = sha256("account:PriceUpdateV2")[..8]. Hardcoded so an
// upstream layout change forces an explicit update, not a silent wrong-struct parse.
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

// Borsh mirror of pyth_solana_receiver_sdk::PriceUpdateV2 (v1.2.0). Field
// order MUST match the SDK exactly or deserialization parses the wrong bytes.
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
    pub exponent: i32,
    pub publish_time: i64,
    pub _prev_publish_time: i64,
    pub _ema_price: i64,
    pub _ema_conf: u64,
}

// Read+validate the Pyth price and return it normalized to the protocol's
// internal fixed-point (USD * 1e6). See module docstring.
pub fn read_pyth_price(
    price_info: &AccountInfo,
    expected_feed_id: &[u8; 32],
    clock: &Clock,
) -> Result<u64> {
    // 1. Owner check — trust anchor; without it anyone forges a buffer with the
    //    right discriminator.
    // DEMO/LOCALNET (feature = "mock-oracle"): ALSO accept a this-program-owned
    // account (the set_mock_oracle PDA) — only way to get a live price on a bare
    // validator; all other checks still run. MUST NOT ship: stripped for devnet/mainnet.
    #[cfg(feature = "mock-oracle")]
    require!(
        *price_info.owner == PYTH_RECEIVER_PROGRAM_ID || *price_info.owner == crate::ID,
        ErrorCode::InvalidPythAccount
    );
    #[cfg(not(feature = "mock-oracle"))]
    require_keys_eq!(
        *price_info.owner,
        PYTH_RECEIVER_PROGRAM_ID,
        ErrorCode::InvalidPythAccount
    );

    let data = price_info.try_borrow_data()?;
    require!(data.len() >= 8, ErrorCode::InvalidPythAccount);

    // 2. Discriminator — it's a PriceUpdateV2, not (e.g.) a TwapUpdate the
    //    receiver also owns.
    let disc = &data[..8];
    require!(
        disc == PRICE_UPDATE_V2_DISCRIMINATOR,
        ErrorCode::InvalidPythAccount
    );

    // Reader-style `deserialize` (not `try_from_slice`, which errors on trailing
    // bytes): consumes only what each field needs, handling both our 133-byte
    // fixture and a real 134-byte cloned-from-devnet account.
    let mut cursor = &data[8..];
    let parsed = PriceUpdateV2::deserialize(&mut cursor)
        .map_err(|_| error!(ErrorCode::InvalidPythAccount))?;

    // 3. Reject Partial verification (the real SDK enforces this too):
    //    fewer than 2/3 of Wormhole guardians signed.
    require!(
        matches!(parsed.verification_level, VerificationLevel::Full),
        ErrorCode::PythVerificationInsufficient
    );

    // 4. Feed id — wrong-asset rejection (e.g. a BTC/USD feed for a SOL/USD
    //    market).
    require!(
        &parsed.price_message.feed_id == expected_feed_id,
        ErrorCode::PythFeedIdMismatch
    );

    // 5. Freshness. Allow future-dated publish_time (clock skew) but reject
    //    if it's older than MAX_PRICE_AGE_SECS.
    let now = clock.unix_timestamp;
    let max_age = MAX_PRICE_AGE_SECS as i64;
    let age = now.saturating_sub(parsed.price_message.publish_time);
    require!(age <= max_age, ErrorCode::PythPriceStale);

    // 6. Positive price. Zero is a feed-init artifact; negative shouldn't
    //    happen but Pyth's type is signed so we have to check.
    require!(parsed.price_message.price > 0, ErrorCode::PythPriceInvalid);
    let price_u64 = parsed.price_message.price as u64;

    // 7. Confidence guardrail: reject if conf exceeds MAX_PRICE_CONF_BPS of
    //    the price. Done on the RAW mantissa — conf/price is a scale-invariant
    //    ratio, so the exponent is irrelevant here. u128 avoids overflow.
    let conf_bps = (parsed.price_message.conf as u128)
        .checked_mul(10_000)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(price_u64 as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        conf_bps <= MAX_PRICE_CONF_BPS as u128,
        ErrorCode::PythConfidenceTooWide
    );

    // 8. Normalize the raw mantissa to the protocol's internal fixed-point.
    let normalized = normalize_price_to_internal(price_u64, parsed.price_message.exponent)?;
    // A feed so coarse it normalizes to zero (e.g. sub-$0.000001) is unusable.
    require!(normalized > 0, ErrorCode::PythPriceInvalid);

    Ok(normalized)
}

// Pyth reports `mantissa * 10^exponent = USD`; the protocol prices in USD * 1e6
// (= USDC base units per SOL), so internal = mantissa * 10^(exponent + INTERNAL).
// Devnet SOL/USD is exponent -8 -> shift -2 -> divide by 100. The localnet mock
// writes exponent -6 -> shift 0 -> identity (its mantissa is already USD*1e6).
// Pure + checked so it can be unit-tested without a validator/MXE.
pub fn normalize_price_to_internal(mantissa: u64, exponent: i32) -> Result<u64> {
    let shift = exponent
        .checked_add(INTERNAL_PRICE_DECIMALS)
        .ok_or(ErrorCode::MathOverflow)?;
    if shift >= 0 {
        let factor = 10u64
            .checked_pow(shift as u32)
            .ok_or(ErrorCode::MathOverflow)?;
        mantissa.checked_mul(factor).ok_or(error!(ErrorCode::MathOverflow))
    } else {
        let divisor = 10u64
            .checked_pow((-shift) as u32)
            .ok_or(ErrorCode::MathOverflow)?;
        mantissa.checked_div(divisor).ok_or(error!(ErrorCode::MathOverflow))
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_price_to_internal;

    #[test]
    fn devnet_exponent_minus_8_divides_by_100() {
        // Real devnet SOL/USD: mantissa 8_169_415_086 @ expo -8 == $81.69
        // -> internal USD*1e6 = 81_694_150 (truncating division).
        assert_eq!(normalize_price_to_internal(8_169_415_086, -8).unwrap(), 81_694_150);
    }

    #[test]
    fn localnet_fixture_mantissa_normalizes_to_test_peg() {
        // tests/fixtures/pyth_sol_usd.json: 10_000_000 @ expo -8 -> 100_000.
        assert_eq!(normalize_price_to_internal(10_000_000, -8).unwrap(), 100_000);
    }

    #[test]
    fn mock_exponent_minus_6_is_identity() {
        // set_mock_oracle writes mantissa already in USD*1e6 @ expo -6 -> unchanged.
        assert_eq!(normalize_price_to_internal(82_410_000, -6).unwrap(), 82_410_000);
    }

    #[test]
    fn exponent_zero_scales_up_by_1e6() {
        assert_eq!(normalize_price_to_internal(83, 0).unwrap(), 83_000_000);
    }

    #[test]
    fn overflow_is_an_error_not_a_panic() {
        // A huge positive exponent would overflow u64 -> must return Err, not wrap.
        assert!(normalize_price_to_internal(1_000_000, 30).is_err());
    }

    #[test]
    fn sub_micro_dollar_truncates_to_zero() {
        // mantissa 5 @ expo -8 -> 5/100 -> 0 (caller rejects 0 as PythPriceInvalid).
        assert_eq!(normalize_price_to_internal(5, -8).unwrap(), 0);
    }
}
