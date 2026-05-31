use arcis::*;

// add_together — toolchain canary: tests drive it end-to-end to prove the MXE
// keygen+queue+callback pipeline works, independent of matching logic.

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

// match_batch (v0a) — N-order, oracle-pegged, pool-backstopped batch auction.
//
// Privacy model (the moat): orders are encrypted; MPC sees side/price/size ONLY
// inside the circuit (no node sees them => no pre-trade leak / front-running).
// FILLS are .reveal()'d post-trade like a dark pool printing to the tape (v0
// positions are already public on-chain; encrypted positions are v0.2).
//
// Matching rule — every order crossing the oracle fills its FULL size:
//   long  fills iff price >= oracle ;  short fills iff price <= oracle
// Peers net; the pool absorbs only the residual (total_long-total_short) at the
// oracle price (untouched when balanced). Full fills => no pro-rata => no MPC
// division and no carry-over; a non-crossing order fills 0 and is refunded —
// nothing ever bricks.
//
// n_active (PUBLIC, = on-chain n_orders): how many of the N fixed slots are real;
// inactive slots mask to a zero fill, so process_batch can pad with any envelope.
// Output (all PUBLIC, revealed): clearing_price (=oracle), total_long/short_base
// (callback derives pool net), f{i}_size/f{i}_side per-slot fill for orders[i].owner.

#[encrypted]
mod circuits {
    use arcis::*;

    // Fixed batch arity N=4. Keep in sync with constants::MAX_ORDERS (the buffer
    // holds N slots; process_batch feeds all N). ~half the ACU of N=8.

    #[derive(Copy, Clone)]
    pub struct Order {
        pub side: u8,           // 0 = long, 1 = short
        pub price: u64,         // ticks
        pub size: u64,          // lots
        pub client_nonce: u64,  // client-side correlation tag (unused on-chain)
    }

    #[derive(Copy, Clone)]
    pub struct BatchOutput {
        pub clearing_price: u64,
        pub total_long_base: u64,
        pub total_short_base: u64,
        pub f0_size: u64, pub f0_side: u8,
        pub f1_size: u64, pub f1_side: u8,
        pub f2_size: u64, pub f2_side: u8,
        pub f3_size: u64, pub f3_side: u8,
    }

    #[instruction]
    pub fn match_batch(
        o0: Enc<Shared, Order>,
        o1: Enc<Shared, Order>,
        o2: Enc<Shared, Order>,
        o3: Enc<Shared, Order>,
        n_active: u64,
        oracle_price: u64,
    ) -> BatchOutput {
        let a0 = o0.to_arcis();
        let a1 = o1.to_arcis();
        let a2 = o2.to_arcis();
        let a3 = o3.to_arcis();

        let long0 = a0.side == 0u8;
        let long1 = a1.side == 0u8;
        let long2 = a2.side == 0u8;
        let long3 = a3.side == 0u8;

        // Crosses the oracle (long buys at/above, short sells at/below).
        let cross0 = if long0 { a0.price >= oracle_price } else { a0.price <= oracle_price };
        let cross1 = if long1 { a1.price >= oracle_price } else { a1.price <= oracle_price };
        let cross2 = if long2 { a2.price >= oracle_price } else { a2.price <= oracle_price };
        let cross3 = if long3 { a3.price >= oracle_price } else { a3.price <= oracle_price };

        // active_i is a PUBLIC comparison (i is const, n_active is plaintext).
        let fills0 = (0u64 < n_active) && (a0.side <= 1u8) && cross0;
        let fills1 = (1u64 < n_active) && (a1.side <= 1u8) && cross1;
        let fills2 = (2u64 < n_active) && (a2.side <= 1u8) && cross2;
        let fills3 = (3u64 < n_active) && (a3.side <= 1u8) && cross3;

        let s0 = if fills0 { a0.size } else { 0u64 };
        let s1 = if fills1 { a1.size } else { 0u64 };
        let s2 = if fills2 { a2.size } else { 0u64 };
        let s3 = if fills3 { a3.size } else { 0u64 };

        // Long/short base totals (u128 accumulation; the pool's signed net is
        // derived on the Anchor side, which already does i128 math).
        let total_long = (if long0 { s0 as u128 } else { 0u128 })
            + (if long1 { s1 as u128 } else { 0u128 })
            + (if long2 { s2 as u128 } else { 0u128 })
            + (if long3 { s3 as u128 } else { 0u128 });
        let total_short = (if long0 { 0u128 } else { s0 as u128 })
            + (if long1 { 0u128 } else { s1 as u128 })
            + (if long2 { 0u128 } else { s2 as u128 })
            + (if long3 { 0u128 } else { s3 as u128 });

        // Reveal at the top level (outside any conditional) — every field
        // collapses to a single committed value before reveal, no branch leaks.
        BatchOutput {
            clearing_price: oracle_price,
            total_long_base: total_long as u64,
            total_short_base: total_short as u64,
            f0_size: s0, f0_side: a0.side,
            f1_size: s1, f1_side: a1.side,
            f2_size: s2, f2_side: a2.side,
            f3_size: s3, f3_side: a3.side,
        }
        .reveal()
    }
}
