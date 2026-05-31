// Quick on-chain state dump: pool, all positions, batch buffer. Diagnostic.
process.env.ARCIUM_CLUSTER_OFFSET ??= "0";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { deriveMarketPda, deriveBatchBufferPda, derivePoolPda } from "@confidential-perps/sdk";
import { ConfidentialPerps } from "../target/types/confidential_perps";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

async function main() {
  const admin = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"), "utf8"))),
  );
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/confidential_perps.json", "utf8"));
  const program = new Program<ConfidentialPerps>(idl, provider);
  const [market] = deriveMarketPda(program.programId);
  const [bb] = deriveBatchBufferPda(market, program.programId);
  const [poolPda] = derivePoolPda(market, program.programId);

  const pool = await (program.account as any).pool.fetch(poolPda);
  console.log("POOL:", { base: pool.baseAmountLots.toString(), quote: pool.quoteEntry.toString(), collateral: pool.collateral.toString() });

  const buf = await (program.account as any).batchBuffer.fetch(bb);
  console.log("BATCH:", { id: buf.batchId.toString(), n: buf.nOrders, isProcessing: buf.isProcessing, owners: buf.orders.slice(0, buf.nOrders).map((o: any) => o.owner.toBase58().slice(0, 8)) });

  const positions = await (program.account as any).position.all();
  console.log(`POSITIONS (${positions.length}):`);
  for (const p of positions) {
    console.log("  ", p.account.owner.toBase58().slice(0, 8), "base=", p.account.baseAmountLots.toString(), "quote=", p.account.quoteEntry.toString(), "margin=", p.account.marginLocked.toString());
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
