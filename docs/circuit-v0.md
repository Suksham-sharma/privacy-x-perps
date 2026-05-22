# Matching circuit v0 — design sketch

> **Status:** draft for review. The Arcis circuit lives in `encrypted-ixs/src/lib.rs`. Today it holds the canonical `add_together` example. This doc proposes what replaces it.
>
> **Audience:** the human writing the Arcis code. Claude wrote this sketch; you refine, push back, redesign.

---

## Problem

A confidential uniform-price batch auction for SOL-PERP. Orders are encrypted client-side, posted on-chain, batched, matched off-chain in Arcium's MPC, and the fills + new position commitments come back via callback. The MPC sees plaintext orders **inside the circuit only** — no node sees them individually.

What the circuit must do, in one batch:

1. Accept N encrypted orders (each with side, price, size, owner key).
2. Take Pyth's spot price as a public reference.
3. Compute a clearing price.
4. Compute each order's fill (full / partial / unfilled).
5. Emit per-order fills, encrypted under each owner's key.
6. Emit a public batch summary (total volume, count, clearing price band — keep TBD; see open questions).
7. Update each touched user's position commitment.

---

## What's encrypted vs public

| Field | Encrypted | Public | Notes |
|---|---|---|---|
| Order side, price, size, owner | ✓ | | Each order is a `Enc<Shared, Order>` |
| Oracle price (Pyth) | | ✓ | Constraint / reference. Public input to the circuit. |
| Market params (tick size, lot size, max deviation from oracle) | | ✓ | Constants. |
| Per-order fill (price, size) | ✓ | | Re-encrypted to each owner. |
| Clearing price | ? | ? | **Open question.** Revealing helps with verifiability and post-trade transparency; hiding maximizes information protection. Drift-style DEXes reveal it. CEX dark pools hide it. |
| Total volume per batch | | ✓ | Useful for funding rate / TWAP feeds. Reveal. |
| Position commitment (after update) | ✓ (commitment) | hash visible | Pedersen / threshold-encrypted commitment. Hash goes into merkle root. |
| Liquidation reveal | | ✓ | Option A: when underwater, position is revealed to the keeper. |

---

## Proposed v0 types

```rust
// In encrypted-ixs/src/lib.rs

#[encrypted]
mod circuits {
    use arcis::*;

    // Public market constants. Could become circuit input later.
    pub const MAX_ORDERS: usize = 8;       // v0; bump to 16 -> 32 once we measure ACUs
    pub const TICK_SIZE: u64 = 1_000;      // 6 decimal USDC -> 0.001 USDC ticks; revisit
    pub const LOT_SIZE: u64 = 100_000;     // 0.1 SOL minimum lot at 9 decimals; revisit

    pub struct Order {
        pub owner_x25519: [u8; 32],   // public key used to re-encrypt fill back to owner
        pub side: u8,                  // 0 = long, 1 = short
        pub price: u64,                // ticks. price-on-the-wire = price * TICK_SIZE
        pub size: u64,                 // lots. size-on-the-wire = size * LOT_SIZE
        pub margin_committed: u64,     // USDC base units locked when order was posted
        pub nonce: u64,                // per-order unique nonce -> replay protection
    }

    pub struct Batch {
        pub orders: [Order; MAX_ORDERS],
        pub n_filled_slots: u8,        // how many of the MAX_ORDERS slots are real orders
    }

    pub struct Fill {
        pub owner_x25519: [u8; 32],
        pub fill_size: u64,            // 0 if unfilled
        pub fill_price: u64,           // tick price; 0 if unfilled
        pub side: u8,
        pub order_nonce: u64,          // matches the input order for client correlation
    }

    pub struct BatchOutput {
        pub fills: [Fill; MAX_ORDERS],
        pub clearing_price: u64,       // tick price; 0 if no match
        pub total_volume: u64,         // sum of fill_size
    }
}
```

Trade-offs worth noting:
- **Fixed-size arrays.** Arcis (per BLINDBID / Crafts examples) wants statically-sized buffers. Hence `MAX_ORDERS` constant and `n_filled_slots` to mark empties. Cost: every batch is sized for worst case. Pay it.
- **Tick / lot scaling.** Working in scaled integers keeps the circuit cheap (no fixed-point math). Marshalling happens at the client.
- **No funding inside the circuit.** Funding rate is applied separately on-chain at settlement — keeps the matching circuit narrow.

---

## Match algorithm (proposed)

Uniform-price batch auction. Plain language:

1. Split orders into `bids` (side=0) and `asks` (side=1), keep size 0 entries inert.
2. Sort bids descending by price; asks ascending.
3. Walk both lists, accumulating filled-volume curves.
4. The clearing price is the highest price `p` where cumulative ask-supply at `p` ≥ cumulative bid-demand at `p`. (Equivalent to crossing supply and demand.)
5. Constrain `clearing_price` to be within ± X% of the Pyth oracle. If no valid price, batch closes with no fills.
6. Build the `Fill` array — fully-filled orders at clearing price, marginal orders prorated, unfilled orders zeroed.

In Arcis, the sort + walk has to be data-independent (branch-free, MPC-friendly). The BLINDBID example shows the comparable pattern — same trick should apply.

Key cost concern: sorts in MPC are expensive. For `MAX_ORDERS = 8` it's cheap (bitonic sort or odd-even). For 32 it's still fine. For 128+ we'd need to think harder.

---

## Position update

Out of scope for the matching circuit itself. The on-chain `match_callback` will:

1. Receive the `BatchOutput`.
2. For each non-zero fill, look up the owner's position commitment in the merkle tree.
3. Apply the delta: `position.base += signed(fill_size); position.quote -= fill_size * clearing_price`.
4. Re-commit the position (Pedersen / threshold-encrypted), update merkle root.

This keeps the matching circuit focused on its one job.

---

## Open questions for the human

1. **Reveal clearing price?** I'd vote yes (matches Drift, helps verifiability, simplifies merkle proofs). Hiding it is doable but costlier and harder to debug.
2. **Per-user multiple positions?** Handover cut list item #1 says one position per user. Lock at one for v0?
3. **Partial fills at the marginal price level — pro-rata or time-priority?** Pro-rata is simpler in MPC (no per-order timestamp). Recommend pro-rata for v0.
4. **`MAX_ORDERS = 8`** for v0 — agree? Lets us iterate fast. Bump after Week 3 when we know the per-order ACU cost.
5. **Pyth oracle band.** What's "X%" — 5%? 10%? Need to pin so the circuit can constrain it.
6. **Nonces for orders.** Per-order client-chosen `nonce` lets the client correlate fills back to specific submitted orders. Open: should the program also track these to prevent replays?
7. **No-match outcome.** When no clearing price exists, what does the callback do? Refund margin, emit a NoMatch event? Or do nothing and let orders carry to next batch?

---

## Skeleton — what `encrypted-ixs/src/lib.rs` becomes

```rust
use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // ... types from above ...

    #[instruction]
    pub fn match_batch(
        batch_ctxt: Enc<Shared, Batch>,
        oracle_price: u64,  // public input
    ) -> Enc<Shared, BatchOutput> {
        let batch = batch_ctxt.to_arcis();
        let oracle_band_lo = oracle_price * 95 / 100;  // ±5%
        let oracle_band_hi = oracle_price * 105 / 100;

        // 1. Separate bids/asks (sentinel-pad empties)
        // 2. Sort (data-oblivious)
        // 3. Find clearing price
        // 4. Constrain to oracle band
        // 5. Build fills array
        // 6. Return BatchOutput

        let output = /* ... */;
        batch_ctxt.owner.from_arcis(output)
    }
}
```

The Anchor side then becomes a `submit_order` instruction (encrypted order in, append to batch buffer) and a `process_batch` instruction (close window, `queue_computation(match_batch)`), with `match_batch_callback` consuming the `BatchOutput` and updating commitments.

---

## What this replaces

The current `programs/confidential_perps/src/instructions/add_together.rs` is the reference pattern. We keep it as a sanity check for the wiring (it's our smoke test) and add the new files alongside, then delete `add_together` once `match_batch` is end-to-end on devnet.
