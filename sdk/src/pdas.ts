// PDA derivation helpers. Single source of truth for seeds — the Anchor
// program defines them in constants.rs; mirror them here.
import { PublicKey } from "@solana/web3.js";

export const MARKET_SEED = Buffer.from("market");
export const BATCH_BUFFER_SEED = Buffer.from("batch");
export const USER_COLLATERAL_SEED = Buffer.from("collateral");
export const POSITION_SEED = Buffer.from("position");
// DEMO/LOCALNET ONLY: program-owned mock PriceUpdateV2 a localnet crank keeps
// fresh (program built with feature = "mock-oracle"). See set_mock_oracle.rs.
export const MOCK_ORACLE_SEED = Buffer.from("mock_oracle");

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

export function derivePositionPda(
  market: PublicKey,
  owner: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    programId,
  );
}

// DEMO/LOCALNET ONLY: the program-owned mock PriceUpdateV2 account. Pass this as
// `price_update` to process_batch / close_position / liquidate_position, and the
// crank pushes live SOL into it via set_mock_oracle.
export function deriveMockOraclePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MOCK_ORACLE_SEED], programId);
}
