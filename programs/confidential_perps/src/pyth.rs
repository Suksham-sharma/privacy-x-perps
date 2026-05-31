// Pyth Pull Oracle reader.
//
// Deliberately avoids `pyth-solana-receiver-sdk`: its 1.x line pins
// anchor-lang ^0.32.1, but Arcium pins us to 1.0.2, so it won't compile. We
// hand-roll the minimum `PriceUpdateV2` shape and Borsh-deserialize it (layout
// from pyth-solana-receiver-sdk v1.2.0). The owner check is the trust boundary
// — the account must be owned by the Pyth receiver program; we never accept an
// arbitrary Borsh blob.
//
// Validated, in order: (1) owner, (2) discriminator, (3) Full verification
// (no Partial — weakens the trust model), (4) feed_id (right asset),
// (5) freshness vs MAX_PRICE_AGE_SECS, (6) price > 0, (7) conf/price within
// MAX_PRICE_CONF_BPS.
//
// Deferred to v0.2: exponent normalization (we return the raw mantissa; the
// keeper must emit orders in Pyth's exponent, -8 for SOL/USD) and ema/TWAP
// (perp matching wants a point estimate, not a smoothed one).
//
use crate::{
    constants::{MAX_PRICE_AGE_SECS, MAX_PRICE_CONF_BPS, PYTH_RECEIVER_PROGRAM_ID},
    error::ErrorCode,
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;

// 8-byte Anchor discriminator for `PriceUpdateV2` = first 8 bytes of
// sha256("account:PriceUpdateV2"). Hardcoded so a layout change upstream
// forces an explicit update here instead of silently parsing a different struct.
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
    pub _exponent: i32,
    pub publish_time: i64,
    pub _prev_publish_time: i64,
    pub _ema_price: i64,
    pub _ema_conf: u64,
}

// Read + validate + return a Pyth price as a u64 mantissa (the raw
// `price_message.price`, cast from i64 after the > 0 check). See the module
// docstring for what's validated and deferred. Callers use it directly as
// oracle_price / exit_price; exponent normalization is the keeper's job in v0.
pub fn read_pyth_price(
    price_info: &AccountInfo,
    expected_feed_id: &[u8; 32],
    clock: &Clock,
) -> Result<u64> {
    // 1. Owner check — the trust anchor; without it anyone can forge a buffer
    //    with the right discriminator.
    //
    // DEMO/LOCALNET (feature = "mock-oracle"): also accept an account owned by
    // THIS program — the `set_mock_oracle` PDA a localnet crank keeps fresh.
    // A bare validator has no Pyth publisher network, so this is the only way
    // to get a live, ticking price locally. The remaining checks (discriminator,
    // Full verification, feed_id, freshness, conf) still run unchanged.
    // MUST NOT ship: the `mock-oracle` feature is stripped for devnet/mainnet.
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

    // Reader-style `deserialize`, not `try_from_slice`: real on-chain accounts
    // are 134 bytes (Pyth allocates for the worst-case Partial variant, leaving
    // a trailing zero) and try_from_slice errors on trailing bytes. deserialize
    // consumes only what each field needs, so one path handles both our
    // 133-byte localnet fixture and a real cloned-from-devnet account.
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
    //    the price. u128 avoids overflow on `conf * 10_000`.
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
