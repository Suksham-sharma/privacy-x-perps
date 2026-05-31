// Cluster-agnostic runtime config from NEXT_PUBLIC_* env. Defaults are the live
// DEVNET deployment, so the app works on Vercel even if an env var is missing
// (never falls back to localhost). Localnet dev overrides via .env.local
// (scripts/localnet-bootstrap.ts emits it).
import { PublicKey } from "@solana/web3.js";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
    "EhTFnsoyZp9aRYoZrFPVPtokiRLwjxvAgZAuEQG8yZgF",
);

// Public Arcium devnet cluster offset (localnet is 0 — set via env for local dev).
export const ARCIUM_CLUSTER_OFFSET = Number(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET ?? "456",
);

// Devnet USDC mint we control (scripts/.devnet-state.json). Localnet overrides via env.
export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ??
    "9oCp3qLSCrGWs97b6Mq9MVMUsRgBw3tSRtfPtT2XA9tR",
);

// Canonical SOL/USD sponsored PriceUpdateV2 address — the localnet fixture is
// seeded at this same address (see build-pyth-fixture.mjs / devnet-init.ts).
export const PYTH_PRICE_UPDATE = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_PRICE_UPDATE ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);
