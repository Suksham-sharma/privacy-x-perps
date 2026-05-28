// Liquidation + batch cranker keeper.
//
// Two jobs run on a poll loop:
//   1. Batch cranker — when BatchBuffer has 2 orders + window closed +
//      !is_processing, call process_batch. process_batch is
//      permissionless, so anyone signing as `payer` can crank it.
//   2. Liquidator — list every open Position, read current Pyth price,
//      compute credit = margin + base*price + quote. If
//      credit < margin/2 (50% maintenance), call liquidate_position.
//
// Run (workspace root):
//   pnpm --filter @confidential-perps/keeper start
//
// Env:
//   SOLANA_RPC_URL          (default http://localhost:8899)
//   ANCHOR_WALLET           (default ~/.config/solana/id.json)
//   ARCIUM_CLUSTER_OFFSET   (default 0 — localnet; use 456 for devnet)
//   PYTH_PRICE_UPDATE       (default 7UVimff... — SOL/USD sponsored feed)
//   KEEPER_INTERVAL_MS      (default 3000)
//   KEEPER_ONCE             (truthy → run a single cycle and exit;
//                            useful for tests / cron-style invocation)

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getClusterAccAddress,
} from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
} from "@confidential-perps/sdk";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Default to localnet cluster offset so arcium-client helpers don't
// throw when ARCIUM_CLUSTER_OFFSET isn't set in the env.
process.env.ARCIUM_CLUSTER_OFFSET ??= "0";

const POLL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 3000);
const CLUSTER_OFFSET = Number(process.env.ARCIUM_CLUSTER_OFFSET);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const PYTH_PRICE_UPDATE = new PublicKey(
  process.env.PYTH_PRICE_UPDATE ??
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);
const ONCE = !!process.env.KEEPER_ONCE;

function ts() {
  return new Date().toISOString().slice(11, 23);
}
function log(msg: string, data?: Record<string, unknown>) {
  const tail = data ? "  " + JSON.stringify(data) : "";
  console.log(`[${ts()}] ${msg}${tail}`);
}

// PriceUpdateV2 layout — mirrors programs/confidential_perps/src/pyth.rs.
// Offsets after the 8-byte Anchor discriminator:
//   write_authority: 32  (bytes 8..40)
//   verification_lvl:  1  (byte 40 — 0=Partial+u8, 1=Full)
//   feed_id:          32  (bytes 41..73 — when Full)
//   price:             8  (bytes 73..81 — i64 LE)
function readPythPrice(data: Buffer): bigint {
  if (data.length < 81) throw new Error(`pyth account too short: ${data.length}`);
  const verLevel = data[8 + 32];
  // Partial encodes [0, num_sigs_u8] = 2 bytes; Full encodes [1] = 1 byte.
  const priceOffset = verLevel === 1 ? 8 + 32 + 1 + 32 : 8 + 32 + 2 + 32;
  return data.readBigInt64LE(priceOffset);
}

async function maybeCrank(
  program: Program<any>,
  marketPda: PublicKey,
  batchBufferPda: PublicKey,
  payer: PublicKey,
) {
  let market: any;
  let buf: any;
  try {
    market = await program.account.market.fetch(marketPda);
    buf = await program.account.batchBuffer.fetch(batchBufferPda);
  } catch {
    // Market not initialized yet — skip silently. Useful for fresh
    // localnet starts before the bootstrap runs.
    return;
  }

  if (buf.isProcessing) return;
  if (buf.nOrders !== 2) return;

  const nowSlot = await program.provider.connection.getSlot();
  const closesAt =
    BigInt(buf.openedAtSlot.toString()) +
    BigInt(market.batchWindowSlots.toString());
  if (BigInt(nowSlot) < closesAt) return;

  // All gates pass — crank.
  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const compDefOffset = Buffer.from(
    getCompDefAccOffset("match_batch"),
  ).readUInt32LE();

  await program.methods
    .processBatch(computationOffset)
    .accountsPartial({
      payer,
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
      executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
      computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
      compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
      clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
      market: marketPda,
      batchBuffer: batchBufferPda,
      priceUpdate: PYTH_PRICE_UPDATE,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  log("crank → process_batch queued", {
    batchId: buf.batchId.toString(),
    offset: computationOffset.toString().slice(0, 12),
  });
}

async function maybeLiquidate(
  program: Program<any>,
  marketPda: PublicKey,
  liquidator: PublicKey,
) {
  // Pyth price (raw bytes — we only need the i64 mantissa).
  const pythAcc = await program.provider.connection.getAccountInfo(
    PYTH_PRICE_UPDATE,
  );
  if (!pythAcc) {
    log("pyth account missing, skipping liquidations");
    return;
  }
  const price = readPythPrice(pythAcc.data);

  const positions = (await program.account.position.all()) as Array<{
    publicKey: PublicKey;
    account: any;
  }>;
  if (positions.length === 0) return;

  for (const { publicKey: posPda, account: pos } of positions) {
    const base = BigInt(pos.baseAmountLots.toString());
    if (base === 0n) continue; // closed already
    if ((pos.owner as PublicKey).equals(liquidator)) continue; // no self-liq
    const margin = BigInt(pos.marginLocked.toString());
    const quote = BigInt(pos.quoteEntry.toString());
    const pnl = base * price + quote;
    const credit = margin + pnl;
    const maintenance = margin / 2n;
    if (credit >= maintenance) continue; // healthy

    const [uc] = deriveUserCollateralPda(marketPda, pos.owner, program.programId);
    try {
      await program.methods
        .liquidatePosition()
        .accounts({
          liquidator,
          market: marketPda,
          position: posPda,
          userCollateral: uc,
          priceUpdate: PYTH_PRICE_UPDATE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      log("liquidated", {
        owner: (pos.owner as PublicKey).toBase58().slice(0, 8) + "…",
        pnl: pnl.toString(),
        credit: credit.toString(),
        maint: maintenance.toString(),
      });
    } catch (e: any) {
      log("liq failed (likely race or healthy-by-now)", {
        owner: (pos.owner as PublicKey).toBase58().slice(0, 8) + "…",
        err: String(e?.message ?? e).slice(0, 80),
      });
    }
  }
}

async function tick(
  program: Program<any>,
  marketPda: PublicKey,
  batchBufferPda: PublicKey,
  payer: PublicKey,
) {
  try {
    await maybeCrank(program, marketPda, batchBufferPda, payer);
  } catch (e: any) {
    log("crank err", { err: String(e?.message ?? e).slice(0, 120) });
  }
  try {
    await maybeLiquidate(program, marketPda, payer);
  } catch (e: any) {
    log("liq sweep err", { err: String(e?.message ?? e).slice(0, 120) });
  }
}

async function main() {
  const keypairPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
    ),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Compiled IDL lives in target/idl/. We use it untyped so the keeper
  // package builds standalone without target/types/ available.
  const idlPath = path.join(__dirname, "../../target/idl/confidential_perps.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new Program(idl, provider);
  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);

  log("keeper start", {
    rpc: RPC_URL,
    program: program.programId.toBase58(),
    payer: wallet.publicKey.toBase58().slice(0, 8) + "…",
    cluster: CLUSTER_OFFSET,
    interval_ms: POLL_MS,
    once: ONCE,
  });

  if (ONCE) {
    await tick(program, marketPda, batchBufferPda, wallet.publicKey);
    return;
  }

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    log("SIGINT — shutting down after current tick");
  });

  while (!stopped) {
    await tick(program, marketPda, batchBufferPda, wallet.publicKey);
    if (stopped) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
