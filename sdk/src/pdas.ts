// PDA derivation helpers. Single source of truth for seeds — the Anchor
// program defines them in constants.rs; mirror them here.
import { PublicKey } from "@solana/web3.js";

export const MARKET_SEED = Buffer.from("market");
export const BATCH_BUFFER_SEED = Buffer.from("batch");
export const USER_COLLATERAL_SEED = Buffer.from("collateral");

export function deriveMarketPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MARKET_SEED], programId);
}

export function deriveBatchBufferPda(
  market: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BATCH_BUFFER_SEED, market.toBuffer()],
    programId,
  );
}

export function deriveUserCollateralPda(
  market: PublicKey,
  user: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_COLLATERAL_SEED, market.toBuffer(), user.toBuffer()],
    programId,
  );
}
