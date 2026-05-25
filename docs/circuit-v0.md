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

> **v0 reality check (added after research):** in v0 the on-chain UserCollateral
> and (future plain) Position PDAs are publicly readable. Any fill leaks its size
> through state deltas regardless of whether the fill instruction itself was
> encrypted. So in v0 we don't try to encrypt fill *delivery* — we lean on order
> encryption (the moat). Encrypted fill delivery becomes meaningful in **v0.2**
> when Position is stored as an encrypted commitment (task #21); see the v0 vs
> v0.2 section below.

| Field | Encrypted (v0) | Public (v0) | Notes |
|---|---|---|---|
| Order side, price, size, owner | ✓ | | Each order is a `Enc<Shared, Order>`. The moat. |
| Oracle price (Pyth) | | ✓ | Public input to the circuit. |
| Market params (tick, lot, oracle band) | | ✓ | Constants. |
| Per-order fill (size, side) | | ✓ | Revealed via `BatchOutput { .. }.reveal()`. Callback applies directly. |
| Clearing price | | ✓ | Revealed (locked decision). |
| Total volume per batch | | ✓ | Revealed (locked decision). |
| Position state (v0) | | ✓ | Plain `Position` PDA for v0; encrypted in v0.2. |
| Position commitment (v0.2) | ✓ (Pedersen / threshold) | hash visible | Future. Hash goes into merkle root. |
| Liquidation reveal | | ✓ | Option A: when underwater, position revealed. |

## v0 vs v0.2: why fill delivery isn't encrypted in v0

We considered a hash-commitment fill flow (encrypted Fill blob delivered to
each owner + public SHA3-256 commitment + later `claim_fill` instruction
that reconstructs the hash). Built it, measured 1.83B ACUs vs 711M without.
Then traced what an observer actually sees:

```
Path A (revealed fills):    block N — Alice.balance: 100 → 95
Path B (hash-commit claim): block N+k — Alice.balance: 100 → 95
```

Both leak the same delta. Path B just delays it by `k` blocks. **The leak
isn't through the fill instruction; it's through the public state update.**
Encrypting the fill blob is performative privacy in v0.

To close the side-channel, the *state being updated* has to be hidden too.
That's a Position-state question, not a fill-delivery question. Hence:

- **v0** (now) — revealed fills, plain Position state. Moat = order encryption.
- **v0.2** (after task #21) — encrypted Position commitments via Pedersen /
  threshold encryption. *Then* hash-commit fills add real privacy, because
  Alice's commitment delta no longer reveals the fill size.

The hash-commit pattern isn't wasted work — it's the right primitive for
v0.2. Captured the design in this commit and reverted to v0 simplicity.

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

## Locked decisions (v0)

1. **Reveal clearing price.** Public per-batch. Matches Drift; debuggable; v2 can hide it later.
2. **One position per user.** Fills aggregate into a single position. Smaller merkle tree, simpler state.
3. **Pro-rata partial fills** at the marginal price level. No timestamps needed; MPC-friendly.
4. **`MAX_ORDERS = 8`.** Re-measure ACUs after Week 3, bump to 16/32 then.
5. **Pyth band: ±5%.** Clearing price outside `[oracle * 0.95, oracle * 1.05]` → NoMatch.
6. **Nonces: client-side only.** Each order carries a `u64` client nonce so the client can correlate the encrypted fill back to its order. Program never reads it. Replay protection: Solana blockhash + signatures on `submit_order`.
7. **No-match: refund + event.** When circuit returns sentinel `clearing_price = 0`, the callback unlocks each order's margin and emits a public `NoMatchEvent { batch_id, oracle_price }`.

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
