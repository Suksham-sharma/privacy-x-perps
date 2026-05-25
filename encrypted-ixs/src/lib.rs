use arcis::*;

// add_together — kept as a toolchain canary. tests/confidential_perps.ts
// drives it end-to-end on localnet to prove the MXE keygen + queue +
// callback pipeline works in isolation, independent of our matching logic.

#[encrypted]
mod toolchain_canary {
    use arcis::*;

    pub struct InputValues {
        v1: u8,
        v2: u8,
    }

    #[instruction]
    pub fn add_together(input_ctxt: Enc<Shared, InputValues>) -> Enc<Shared, u16> {
        let input = input_ctxt.to_arcis();
        let sum = input.v1 as u16 + input.v2 as u16;
        input_ctxt.owner.from_arcis(sum)
    }
}

// match_batch v0 — two-order uniform-price match.
//
// Scope per handover Week 2 deliverable: "2-order batch matches in Arcis".
// On-chain BatchBuffer keeps 8 slots; for v0 process_batch will only queue
// the computation when exactly 2 orders are buffered. Once this end-to-end
// flow works, v0.1 extends to MAX_ORDERS=8 with a bitonic sort.
//
// Inputs:
//   a, b           — two orders, each encrypted under its own owner's
//                    Shared key with the MXE.
//   oracle_price   — public Pyth reference (ticks).
//
// Outputs (one per owner):
//   Fill { fill_size, fill_price, side, client_nonce } re-encrypted back
//   to each owner's Shared key. fill_size == 0 means "your order didn't
//   fill in this batch" (callers handle margin refund on-chain).
//
// Algorithm (data-oblivious — every branch is a conditional select):
//   1. Identify which input is the bid (side=0) and which is the ask (side=1).
//   2. Require exactly one of each (otherwise no match).
//   3. Require bid_price >= ask_price (orders cross).
//   4. Clearing price = midpoint of bid_price and ask_price.
//   5. Require clearing price within ±5% of oracle.
//   6. Fill size = min(bid_size, ask_size).
//   7. If any check fails, fill_size = 0 and fill_price = 0.

#[encrypted]
mod circuits {
    use arcis::*;

    // Mirrors EncryptedOrderSlot's plaintext shape (see programs state/mod.rs).
    #[derive(Copy, Clone)]
    pub struct Order {
        pub side: u8,           // 0 = long, 1 = short
        pub price: u64,         // ticks
        pub size: u64,          // lots
        pub client_nonce: u64,  // client-chosen correlation tag
    }

    #[derive(Copy, Clone)]
    pub struct Fill {
        pub fill_size: u64,
        pub fill_price: u64,    // ticks; 0 if unfilled
        pub side: u8,
        pub client_nonce: u64,
    }

    // Oracle band: clearing price must satisfy oracle*(1-0.05) <= p <= oracle*(1+0.05).
    // BPS = 10_000, ORACLE_BAND_BPS = 500.

    #[instruction]
    pub fn match_batch(
        a_ctxt: Enc<Shared, Order>,
        b_ctxt: Enc<Shared, Order>,
        oracle_price: u64,
    ) -> (Enc<Shared, Fill>, Enc<Shared, Fill>) {
        let a = a_ctxt.to_arcis();
        let b = b_ctxt.to_arcis();

        // Pick out bid + ask without leaking which input was which.
        let a_is_bid = a.side == 0u8;
        let bid_price = if a_is_bid { a.price } else { b.price };
        let ask_price = if a_is_bid { b.price } else { a.price };
        let bid_size = if a_is_bid { a.size } else { b.size };
        let ask_size = if a_is_bid { b.size } else { a.size };

        // Sides must each be in {0, 1} and differ. The bid/ask picker above
        // only treats side==0 as bid; without the bounds check, side==2 (or
        // higher) would silently slot into "ask" and corrupt the match.
        let a_side_valid = a.side <= 1u8;
        let b_side_valid = b.side <= 1u8;
        let valid_sides = a_side_valid && b_side_valid && a.side != b.side;

        // Orders cross.
        let crossing = bid_price >= ask_price;

        // Midpoint clearing price. u128 widening prevents overflow at extreme
        // tick values (u64::MAX bid + u64::MAX ask would otherwise wrap).
        let clearing = (((bid_price as u128) + (ask_price as u128)) / 2u128) as u64;

        // Oracle band: clearing ∈ oracle * [9500/10000, 10500/10000]. Same
        // u128 widening — oracle_price * 10500 overflows u64 above ~1.76e15.
        let band_lo = (((oracle_price as u128) * 9500u128) / 10_000u128) as u64;
        let band_hi = (((oracle_price as u128) * 10_500u128) / 10_000u128) as u64;
        let in_band = clearing >= band_lo && clearing <= band_hi;

        let matched = valid_sides && crossing && in_band;

        // Min(bid_size, ask_size) — data-oblivious.
        let raw_fill_size = if bid_size < ask_size { bid_size } else { ask_size };

        // If any check failed, zero out the fill.
        let fill_size = if matched { raw_fill_size } else { 0u64 };
        let fill_price = if matched { clearing } else { 0u64 };

        let fill_a = Fill {
            fill_size,
            fill_price,
            side: a.side,
            client_nonce: a.client_nonce,
        };
        let fill_b = Fill {
            fill_size,
            fill_price,
            side: b.side,
            client_nonce: b.client_nonce,
        };

        (
            a_ctxt.owner.from_arcis(fill_a),
            b_ctxt.owner.from_arcis(fill_b),
        )
    }
}
