# Iceberg

The first confidential perpetual futures DEX on Solana ("confidential perps"). Orders encrypted
client-side, matched in Arcium's MPC network, settled on-chain via Anchor. Like an iceberg order,
your size stays below the surface — only here nothing shows pre-match at all.

Devnet only for now. SIF cohort build.

## Quickstart

```bash
# build (anchor + arcis circuit + idl + ts types)
arcium build

# first run — does MXE keygen, persists keys under artifacts/localnet/
arcium test

# subsequent runs — much faster, reuses persisted keys
pnpm test            # alias for: arcium test --skip-keygen

# force a fresh keygen (rare — circuit changed or persisted state is corrupt)
pnpm test:keygen     # alias for: arcium test
```

## Layout

| Path | Purpose |
|------|---------|
| `programs/confidential_perps/` | Anchor program: state, instructions, callbacks |
| `encrypted-ixs/` | Arcis confidential circuits |
| `tests/` | TypeScript integration tests |
| `sdk/` | Client SDK (wraps the IDL + encryption + PDA derivation) |
| `keeper/` | Liquidation keeper bot |
| `docs/circuit-v0.md` | Matching engine spec |
| `Arcium.toml` | Localnet and MXE cluster config |
| `Anchor.toml` | Solana cluster + provider config |

## Docs

- Arcium: <https://docs.arcium.com/developers>
- Drift v2 (perp accounting reference): <https://github.com/drift-labs/protocol-v2>
- Pyth Pull (oracle): <https://docs.pyth.network/price-feeds/use-real-time-data/solana>
