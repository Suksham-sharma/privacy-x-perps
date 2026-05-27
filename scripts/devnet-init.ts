// Devnet bootstrap: post-deploy init for the perp engine.
//
// Run AFTER `arcium deploy --cluster-offset 456 ... --rpc-url devnet`
// succeeds. Idempotent — re-running skips already-initialized accounts.
//
//   pnpm exec ts-node scripts/devnet-init.ts
//
// Does the work tests/matching.ts does in its `init` describe block:
//   1. Create a fresh USDC mint (we control mint authority; canonical
//      4zMMC9... is Circle-owned and we can't mint to ourselves).
//   2. init_market(SOL_USD_FEED_ID, usdcMint) — creates Market + BatchBuffer
//      + USDC vault ATA owned by the Market PDA.
//   3. init_match_batch_comp_def — registers the match_batch circuit with
//      the MXE so process_batch can queue computations.
//   4. uploadCircuit — pushes the compiled match_batch.arcis bytes to
//      Arcium.

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  getArciumProgram,
  getArciumProgramId,
  getArciumAccountBaseSeed,
  getCompDefAccOffset,
  getMXEAccAddress,
  getLookupTableAddress,
  uploadCircuit,
} from "@arcium-hq/client";
import { deriveMarketPda, deriveBatchBufferPda } from "@confidential-perps/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const USDC_DECIMALS = 6;
const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const keypairPath =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");

  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
    ),
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/confidential_perps.json", "utf8"),
  );
  const program = new Program<ConfidentialPerps>(idl, provider);

  console.log("Cluster        :", rpcUrl);
  console.log("Admin wallet   :", wallet.publicKey.toBase58());
  console.log("Program ID     :", program.programId.toBase58());

  const balance = await connection.getBalance(wallet.publicKey);
  console.log("Wallet balance :", (balance / 1e9).toFixed(4), "SOL");
  if (balance < 0.1 * 1e9) {
    throw new Error("Admin wallet has < 0.1 SOL; top up before continuing.");
  }

  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);
  console.log("Market PDA     :", marketPda.toBase58());
  console.log("BatchBuffer PDA:", batchBufferPda.toBase58());

  // -- USDC mint --
  // Reuse a previously-created devnet mint if one is recorded.
  const mintRegistryPath = "scripts/.devnet-state.json";
  let usdcMint: PublicKey;
  let state: { usdcMint?: string } = {};
  if (fs.existsSync(mintRegistryPath)) {
    state = JSON.parse(fs.readFileSync(mintRegistryPath, "utf8"));
  }
  if (state.usdcMint) {
    usdcMint = new PublicKey(state.usdcMint);
    console.log("USDC mint      :", usdcMint.toBase58(), "(reused)");
  } else {
    console.log("Creating USDC mint...");
    usdcMint = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,
      null,
      USDC_DECIMALS,
    );
    state.usdcMint = usdcMint.toBase58();
    fs.writeFileSync(mintRegistryPath, JSON.stringify(state, null, 2));
    console.log("USDC mint      :", usdcMint.toBase58(), "(new)");
  }

  const vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
  console.log("USDC vault ATA :", vaultAta.toBase58());

  // -- init_market --
  const marketAcc = await connection.getAccountInfo(marketPda);
  if (marketAcc) {
    console.log("init_market    : SKIP (Market PDA already exists)");
  } else {
    const solUsdFeedId = Array.from(Buffer.from(SOL_USD_FEED_ID_HEX, "hex"));
    const sig = await program.methods
      .initMarket(solUsdFeedId)
      .accounts({
        admin: wallet.publicKey,
        market: marketPda,
        batchBuffer: batchBufferPda,
        usdcMint,
        usdcVault: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("init_market    : OK  tx", sig);
  }

  // -- init_match_batch_comp_def --
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("match_batch");
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];
  const compDefAcc = await connection.getAccountInfo(compDefPda);
  if (compDefAcc) {
    console.log("comp_def       : SKIP (already initialized)");
  } else {
    const mxeAccount = getMXEAccAddress(program.programId);
    const arciumProgram = getArciumProgram(provider);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot,
    );

    const sig = await program.methods
      .initMatchBatchCompDef()
      .accounts({
        payer: wallet.publicKey,
        mxeAccount,
        compDefAccount: compDefPda,
        addressLookupTable: lutAddress,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log("comp_def       : OK  tx", sig);
  }

  // Always (re-)attempt the circuit upload — partial uploads from a
  // dropped RPC connection re-resume cleanly; a fully-uploaded circuit
  // is a no-op on the second call.
  console.log("Uploading match_batch circuit (re-runs are idempotent)...");
  const rawCircuit = fs.readFileSync("build/match_batch.arcis");
  await uploadCircuit(
    provider,
    "match_batch",
    program.programId,
    rawCircuit,
    true,
    500,
    {
      skipPreflight: true,
      preflightCommitment: "confirmed",
      commitment: "confirmed",
    },
  );
  console.log("circuit upload : OK");

  // -- Verify on-chain state matches expectations --
  const market = await (program.account as any).market.fetch(marketPda);
  console.log("\n=== Market state ===");
  console.log("pyth_feed_id (hex)   :", Buffer.from(market.pythFeedId).toString("hex"));
  console.log("usdc_mint            :", market.usdcMint.toBase58());
  console.log("usdc_vault           :", market.usdcVault.toBase58());
  console.log("batch_window_slots   :", market.batchWindowSlots.toNumber());
  if (Buffer.from(market.pythFeedId).toString("hex") !== SOL_USD_FEED_ID_HEX) {
    throw new Error("pyth_feed_id mismatch — re-init required");
  }

  console.log("\nDevnet bootstrap complete.");
  console.log("Explorer: https://explorer.solana.com/address/" +
    program.programId.toBase58() + "?cluster=devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
