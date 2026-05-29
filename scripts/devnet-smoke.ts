// Devnet smoke test for the Pyth read path.
//
// Verifies the deployed binary's read_pyth_price works against a REAL 134-byte
// sponsored Pyth account, not just our 133-byte localnet fixture (the senior
// reviewer flagged that the try_from_slice -> reader-style deserialize switch
// should handle both sizes).
//
// Strategy: call process_batch with an empty BatchBuffer (n_orders=0). The
// handler reads Pyth FIRST, then checks n_orders==2, so a clean deserialize
// surfaces BatchNotReady; a failed Pyth read surfaces InvalidPythAccount /
// PythVerificationInsufficient / etc.
//
// Cost: ~5000 lamports tx fee — no Arcium fees, since the handler errors
// before queue_computation.

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getClusterAccAddress,
} from "@arcium-hq/client";
import { deriveMarketPda, deriveBatchBufferPda } from "@confidential-perps/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const DEVNET_CLUSTER_OFFSET = 456; // Arcium public devnet cluster
const PYTH_PRICE_UPDATE = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);

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

  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);

  console.log("Cluster        :", rpcUrl);
  console.log("Program ID     :", program.programId.toBase58());
  console.log("Pyth account   :", PYTH_PRICE_UPDATE.toBase58());

  // Confirm the real Pyth account exists and is 134 bytes (so the
  // deserialize-vs-try_from_slice difference actually matters).
  const pythAcc = await connection.getAccountInfo(PYTH_PRICE_UPDATE);
  if (!pythAcc) throw new Error("Pyth account missing from devnet");
  console.log("Pyth bytes     :", pythAcc.data.length);
  console.log("Pyth owner     :", pythAcc.owner.toBase58());

  // Confirm BatchBuffer is empty (n_orders == 0) so we hit the
  // BatchNotReady gate, not the Pyth gate's success path.
  const buf = await (program.account as any).batchBuffer.fetch(batchBufferPda);
  console.log("BatchBuffer    : n_orders =", buf.nOrders, "is_processing =", buf.isProcessing);
  if (buf.nOrders !== 0) {
    console.warn("WARN: buffer is non-empty; smoke test result may be different");
  }

  // Build the process_batch call.
  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const compDefOffset = Buffer.from(getCompDefAccOffset("match_batch")).readUInt32LE();
  const clusterAccount = getClusterAccAddress(DEVNET_CLUSTER_OFFSET);

  console.log("\nCalling processBatch with empty buffer + real Pyth account...");

  try {
    await program.methods
      .processBatch(computationOffset)
      .accountsPartial({
        payer: wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(DEVNET_CLUSTER_OFFSET),
        executingPool: getExecutingPoolAccAddress(DEVNET_CLUSTER_OFFSET),
        computationAccount: getComputationAccAddress(DEVNET_CLUSTER_OFFSET, computationOffset),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
        clusterAccount,
        market: marketPda,
        batchBuffer: batchBufferPda,
        priceUpdate: PYTH_PRICE_UPDATE,
      })
      .rpc({ skipPreflight: false, commitment: "confirmed" });

    console.log("UNEXPECTED: processBatch succeeded with an empty buffer.");
    process.exit(2);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];

    // Look for our two error codes in the message + logs.
    const isBatchNotReady = /BatchNotReady|0x1775/.test(msg) ||
      logs.some((l) => /BatchNotReady|0x1775/i.test(l));
    const isPythRelated = /InvalidPythAccount|PythVerification|PythFeedIdMismatch|PythPriceStale|PythPriceInvalid|PythConfidenceTooWide/i.test(msg) ||
      logs.some((l) => /InvalidPythAccount|PythVerification|PythFeedIdMismatch|PythPriceStale|PythPriceInvalid|PythConfidenceTooWide/i.test(l));

    if (isBatchNotReady && !isPythRelated) {
      console.log("\n✅ SMOKE PASS: BatchNotReady");
      console.log("   Pyth deserialize handled the real 134-byte account correctly.");
      console.log("   Handler reached the n_orders==2 gate, meaning Pyth read returned Ok.");
      process.exit(0);
    } else if (isPythRelated) {
      console.log("\n❌ SMOKE FAIL: Pyth gate rejected the real account.");
      console.log("   This is what the senior reviewer warned about.");
      console.log("   Error:", msg);
      if (logs.length) console.log("   Logs:\n" + logs.map((l) => "     " + l).join("\n"));
      process.exit(1);
    } else {
      console.log("\n⚠️  SMOKE INCONCLUSIVE: unexpected error path.");
      console.log("   Error:", msg);
      if (logs.length) console.log("   Logs:\n" + logs.map((l) => "     " + l).join("\n"));
      process.exit(3);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
