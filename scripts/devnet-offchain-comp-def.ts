// Devnet OFF-CHAIN comp_def init + stuck-batch recovery (idempotent).
//
// Run AFTER deploying the program built with MATCH_BATCH_CIRCUIT_URL set (so the
// init handler points the comp_def at the off-chain .arcis). Unlike devnet-init.ts
// this does NOT uploadCircuit — off-chain comp_defs store only {url, hash} and the
// ARX nodes fetch + verify the circuit themselves. It also calls expire_batch to
// clear the BatchBuffer wedged by the old (dropped, on-chain) computation.
//
//   SOLANA_RPC_URL=<helius> ANCHOR_WALLET=~/.config/solana/id.json \
//     pnpm exec tsx scripts/devnet-offchain-comp-def.ts
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getArciumProgram,
  getArciumProgramId,
  getArciumAccountBaseSeed,
  getCompDefAccOffset,
  getMXEAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
} from "@confidential-perps/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const CIRCUIT_NAME = "match_batch_oc";

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

  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);

  // -- init off-chain comp_def at the NEW offset (match_batch_oc) --
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset(CIRCUIT_NAME);
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];
  console.log("comp_def PDA   :", compDefPda.toBase58(), `(${CIRCUIT_NAME})`);

  const arciumProgram = getArciumProgram(provider);

  if (await connection.getAccountInfo(compDefPda)) {
    console.log("comp_def       : SKIP (already initialized)");
  } else {
    const mxeAccount = getMXEAccAddress(program.programId);
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
    console.log("comp_def       : OK (off-chain, no upload)  tx", sig);
  }

  // -- verify circuit_source is OffChain --
  const compDef = await (arciumProgram.account as any).computationDefinitionAccount.fetch(
    compDefPda,
  );
  const src = compDef.circuitSource;
  const variant = Object.keys(src)[0];
  console.log("\n=== comp_def circuit_source ===");
  console.log("variant        :", variant);
  if (variant === "offChain") {
    console.log("source URL     :", src.offChain[0].source);
    console.log("hash (hex)     :", Buffer.from(src.offChain[0].hash).toString("hex"));
  } else {
    console.warn(
      "WARNING: circuit_source is NOT off-chain — was the program built with MATCH_BATCH_CIRCUIT_URL set?",
    );
  }
  console.log("deactivationSlot:", compDef.deactivationSlot);
  console.log("cuAmount       :", compDef.cuAmount?.toString?.());

  // -- expire the wedged batch so a fresh batch can be submitted --
  const buf = await (program.account as any).batchBuffer.fetch(batchBufferPda);
  console.log("\n=== BatchBuffer ===");
  console.log("batch_id       :", buf.batchId.toString());
  console.log("n_orders       :", buf.nOrders);
  console.log("is_processing  :", buf.isProcessing);
  if (buf.isProcessing) {
    try {
      const sig = await program.methods
        .expireBatch()
        .accounts({ market: marketPda, batchBuffer: batchBufferPda })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log("expire_batch   : OK  tx", sig);
      const after = await (program.account as any).batchBuffer.fetch(batchBufferPda);
      console.log("is_processing  :", after.isProcessing, " batch_id:", after.batchId.toString());
    } catch (e: any) {
      console.error("expire_batch   : FAILED —", e?.message ?? e);
    }
  } else {
    console.log("expire_batch   : SKIP (buffer not wedged)");
  }

  console.log("\nOff-chain comp_def setup complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
