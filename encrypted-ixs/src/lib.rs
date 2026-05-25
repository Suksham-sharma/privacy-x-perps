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
// Privacy model (v0 — see docs/circuit-v0.md "v0 vs v0.2"):
//   - ORDERS are encrypted during matching — the moat. MPC sees plaintext
//     only inside the circuit; no individual node sees an order's contents.
//     This prevents pre-trade leakage (front-running, strategy copying).
//   - FILLS are revealed publicly via .reveal(). The callback applies each
//     fill to UserCollateral / Position directly. Same model as a dark pool
//     that prints fills to the tape post-trade.
//   - Why this isn't a privacy regression vs encrypted-fill (Path B): in
//     v0 the on-chain UserCollateral and Position PDAs are public, so any
//     fill leaks its size through state deltas regardless of whether the
//     fill *instruction* was encrypted. Hash-commit fill delivery only
//     becomes a real privacy primitive once Position is encrypted (task
//     #21) — that's v0.2.
//
// Outputs (all PUBLIC, revealed via Struct{..}.reveal()):
//   clearing_price — matched price; 0 if no match.
//   total_volume   — sum of all fills; equals fill_a_size in v0 since the
//                    two sides must trade the same lots.
//   fill_a_size    — lots filled for input a (0 if no match).
//   fill_a_side    — 0 long / 1 short, copied through.
//   fill_b_size    — same for b.
//   fill_b_side    — same for b.
// The on-chain callback applies fill_a to BatchBuffer.orders[0].owner
// and fill_b to BatchBuffer.orders[1].owner.

#[encrypted]
mod circuits {
    use arcis::*;

    #[derive(Copy, Clone)]
    pub struct Order {
        pub side: u8,           // 0 = long, 1 = short
        pub price: u64,         // ticks
        pub size: u64,          // lots
        pub client_nonce: u64,  // client-side correlation tag (not used on-chain)
    }

    #[derive(Copy, Clone)]
    pub struct BatchOutput {
        pub clearing_price: u64,
        pub total_volume: u64,
        pub fill_a_size: u64,
        pub fill_a_side: u8,
        pub fill_b_size: u64,
        pub fill_b_side: u8,
    }

    #[instruction]
    pub fn match_batch(
        a_ctxt: Enc<Shared, Order>,
        b_ctxt: Enc<Shared, Order>,
        oracle_price: u64,
    ) -> BatchOutput {
        let a = a_ctxt.to_arcis();
        let b = b_ctxt.to_arcis();

        // Pick out bid + ask without leaking which input was which.
        let a_is_bid = a.side == 0u8;
        let bid_price = if a_is_bid { a.price } else { b.price };
        let ask_price = if a_is_bid { b.price } else { a.price };
        let bid_size = if a_is_bid { a.size } else { b.size };
        let ask_size = if a_is_bid { b.size } else { a.size };

        // Sides must each be in {0, 1} and differ.
        let valid_sides = a.side <= 1u8 && b.side <= 1u8 && a.side != b.side;

        // Orders cross.
        let crossing = bid_price >= ask_price;

        // Midpoint clearing price with u128 widening (overflow-safe).
        let clearing = (((bid_price as u128) + (ask_price as u128)) / 2u128) as u64;

        // Oracle band: clearing ∈ oracle * [9500/10000, 10500/10000].
        let band_lo = (((oracle_price as u128) * 9500u128) / 10_000u128) as u64;
        let band_hi = (((oracle_price as u128) * 10_500u128) / 10_000u128) as u64;
        let in_band = clearing >= band_lo && clearing <= band_hi;

        let matched = valid_sides && crossing && in_band;

        // Fill size = min(bid_size, ask_size); zero on no-match.
        let raw_fill_size = if bid_size < ask_size { bid_size } else { ask_size };
        let final_fill_size = if matched { raw_fill_size } else { 0u64 };
        let final_clearing = if matched { clearing } else { 0u64 };

        // Reveal happens via Struct{..}.reveal() at the top level — outside
        // any conditional. All fields collapse to a single committed value
        // before reveal, so no branch information leaks.
        BatchOutput {
            clearing_price: final_clearing,
            total_volume: final_fill_size,
            fill_a_size: final_fill_size,
            fill_a_side: a.side,
            fill_b_size: final_fill_size,
            fill_b_side: b.side,
        }
        .reveal()
    }
}
