// Cluster-agnostic runtime config from NEXT_PUBLIC_* env with localnet defaults
// (bootstrap emits .env.local; devnet flip is just different env). Program ID is
// stable across clusters.
import { PublicKey } from "@solana/web3.js";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_PROGRAM_ID ??
    "EhTFnsoyZp9aRYoZrFPVPtokiRLwjxvAgZAuEQG8yZgF",
);

// Localnet arcium cluster is always offset 0 (see lifecycle-driver.ts).
export const ARCIUM_CLUSTER_OFFSET = Number(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET ?? "0",
);

// Unknown until bootstrap mints the localnet USDC mint; null is a valid
// "not configured yet" state the Collateral panel handles in a later phase.
export const USDC_MINT = process.env.NEXT_PUBLIC_USDC_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_USDC_MINT)
  : null;

// Canonical SOL/USD sponsored PriceUpdateV2 address — the localnet fixture is
// seeded at this same address (see build-pyth-fixture.mjs / devnet-init.ts).
export const PYTH_PRICE_UPDATE = new PublicKey(
  process.env.NEXT_PUBLIC_PYTH_PRICE_UPDATE ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);
