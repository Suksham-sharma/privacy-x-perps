// Comprehensive DEVNET e2e against the live deployment + real Pyth (no mock oracle, no keeper).
// Scenario A: balanced long+short -> peer match (pool untouched) -> close both (realized PnL).
// Scenario B: lone long -> fills against the pool (no brick), pool goes short 1.
// Funds throwaway wallets with SOL (from admin) + USDC (minted by the faucet mint-authority),
// prices orders around the LIVE normalized Pyth oracle, cranks process_batch itself, and POLLS
// batch_id for settlement (robust vs devnet WS event flakiness). Run:
//   SOLANA_RPC_URL=<helius-devnet> ANCHOR_WALLET=~/.config/solana/id.json pnpm exec tsx scripts/devnet-e2e.ts
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  getMXEPublicKey,
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
  derivePositionPda,
  derivePoolPda,
  encryptOrder,
  toSubmitOrderArgs,
  readNormalizedPythPrice,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import { ConfidentialPerps } from "../target/types/confidential_perps";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes, createHash } from "crypto";

const RPC =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const CLUSTER_OFFSET = Number(process.env.ARCIUM_CLUSTER_OFFSET ?? "456");
const PYTH = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const ONE_USDC = 1_000_000n;
const WALLET_SOL = 0.1; // per throwaway wallet — covers rent (collateral/position PDAs) + fees
const RUN = process.env.RUN_SALT ?? Date.now().toString(36);

function kp(name: string): Keypair {
  return Keypair.fromSeed(
    createHash("sha256").update(`devnet-e2e-${RUN}-${name}`).digest().subarray(0, 32),
  );
}
function load(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
let passed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  passed++;
  console.log("   ✓ " + msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const admin = load(
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json"),
  );
  const faucet = load(path.join(os.homedir(), ".config/solana/iceberg-faucet-devnet.json"));
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/confidential_perps.json", "utf8"));
  const program = new Program<ConfidentialPerps>(idl, provider);

  console.log("RPC          :", RPC.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("Program      :", program.programId.toBase58());
  console.log("Cluster off  :", CLUSTER_OFFSET, " run salt:", RUN);

  const mxe = await getMXEPublicKey(provider, program.programId);
  if (!mxe) throw new Error("MXE pubkey unavailable on devnet");

  const [market] = deriveMarketPda(program.programId);
  const [batchBuffer] = deriveBatchBufferPda(market, program.programId);
  const [poolPda] = derivePoolPda(market, program.programId);
  const marketAcc = await (program.account as any).market.fetch(market);
  const usdcMint: PublicKey = marketAcc.usdcMint;
  const windowSlots = BigInt(marketAcc.batchWindowSlots.toString());
  const vaultAta = await getAssociatedTokenAddress(usdcMint, market, true);

  const pythAcc = await connection.getAccountInfo(PYTH);
  const price = readNormalizedPythPrice(pythAcc?.data ?? null);
  if (price === null) throw new Error("could not read/normalize live Pyth price");
  console.log(`Live oracle  : $${(Number(price) / 1e6).toFixed(2)} (${price} USD*1e6)\n`);

  const fetchPool = () => (program.account as any).pool.fetch(poolPda);
  const fetchPos = (u: PublicKey) =>
    (program.account as any).position.fetch(derivePositionPda(market, u, program.programId)[0]);
  const fetchUc = (u: PublicKey) =>
    (program.account as any).userCollateral.fetch(deriveUserCollateralPda(market, u, program.programId)[0]);

  async function fundSol(u: PublicKey) {
    if ((await connection.getBalance(u)) >= WALLET_SOL * LAMPORTS_PER_SOL) return;
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: u, lamports: WALLET_SOL * LAMPORTS_PER_SOL }),
      ),
      [admin],
      { commitment: "confirmed" },
    );
  }
  async function fundDeposit(u: Keypair, usdc: bigint) {
    await fundSol(u.publicKey);
    const ata = await getOrCreateAssociatedTokenAccount(connection, faucet, usdcMint, u.publicKey);
    await mintTo(connection, faucet, usdcMint, ata.address, faucet, Number(usdc));
    const [uc] = deriveUserCollateralPda(market, u.publicKey, program.programId);
    await program.methods
      .deposit(new anchor.BN(usdc.toString()))
      .accounts({
        user: u.publicKey, market, userCollateral: uc, usdcVault: vaultAta,
        userTokenAccount: ata.address, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([u])
      .rpc({ commitment: "confirmed" });
  }
  let nonce = 1n;
  async function submit(u: Keypair, side: bigint, size: bigint) {
    const orderPrice = side === 0n ? price + price / 50n : price - price / 50n; // long +2% / short -2% so it crosses
    const margin = orderPrice * size;
    const [uc] = deriveUserCollateralPda(market, u.publicKey, program.programId);
    const [pos] = derivePositionPda(market, u.publicKey, program.programId);
    const pt: OrderPlaintext = { side, price: orderPrice, size, clientNonce: nonce++ };
    const args = toSubmitOrderArgs(encryptOrder(pt, mxe));
    await program.methods
      .submitOrder(args.x25519Pubkey, args.nonce, new anchor.BN(margin.toString()), args.ctSide, args.ctPrice, args.ctSize, args.ctClientNonce)
      .accounts({ user: u.publicKey, market, batchBuffer, userCollateral: uc, position: pos, systemProgram: SystemProgram.programId })
      .signers([u])
      .rpc({ commitment: "confirmed" });
  }
  async function waitWindowClose() {
    const buf = await (program.account as any).batchBuffer.fetch(batchBuffer);
    const closesAt = BigInt(buf.openedAtSlot.toString()) + windowSlots;
    for (let i = 0; i < 60; i++) {
      if (BigInt(await connection.getSlot()) >= closesAt) return;
      await sleep(2000);
    }
    throw new Error("batch window did not close in time");
  }
  async function crank() {
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const compDefOffset = Buffer.from(getCompDefAccOffset("match_batch_oc")).readUInt32LE();
    await program.methods
      .processBatch(computationOffset)
      .accountsPartial({
        payer: admin.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
        executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
        computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
        clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
        market, batchBuffer, priceUpdate: PYTH,
      })
      .signers([admin])
      .rpc({ commitment: "confirmed" });
  }
  // Poll batch_id increment = the callback ran (robust vs WS events on devnet).
  async function waitSettle(prevBatchId: bigint, timeoutMs = 180_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const buf = await (program.account as any).batchBuffer.fetch(batchBuffer);
      if (BigInt(buf.batchId.toString()) > prevBatchId && !buf.isProcessing) {
        await sleep(2500); // let position/pool writes settle at "confirmed"
        return;
      }
      await sleep(3000);
    }
    throw new Error("timed out waiting for MPC callback (batch_id did not advance)");
  }
  async function closePos(u: Keypair) {
    const [uc] = deriveUserCollateralPda(market, u.publicKey, program.programId);
    const [pos] = derivePositionPda(market, u.publicKey, program.programId);
    await program.methods
      .closePosition()
      .accounts({ user: u.publicKey, market, position: pos, userCollateral: uc, priceUpdate: PYTH })
      .signers([u])
      .rpc({ commitment: "confirmed" });
  }
  const batchId = async () => BigInt((await (program.account as any).batchBuffer.fetch(batchBuffer)).batchId.toString());
  const DEP = price + 50n * ONE_USDC; // covers ~1x margin (price) + buffer

  // ===== Scenario A: balanced long + short -> peer match, pool untouched, then close =====
  console.log("=== Scenario A: balanced LONG + SHORT → peer match (pool untouched) → close ===");
  const alice = kp("alice");
  const bob = kp("bob");
  await fundDeposit(alice, DEP);
  await fundDeposit(bob, DEP);
  console.log("   funded + deposited alice/bob");
  const poolA0 = await fetchPool();
  const idA = await batchId();
  await submit(alice, 0n, 1n);
  await submit(bob, 1n, 1n);
  console.log("   submitted alice LONG 1 / bob SHORT 1 — waiting for window + crank + MPC settle…");
  await waitWindowClose();
  if (process.env.KEEPER_DRIVEN) {
    console.log("   (KEEPER_DRIVEN) window closed — leaving the crank to the keeper bot…");
  } else {
    await crank();
  }
  await waitSettle(idA);
  const aliceP = await fetchPos(alice.publicKey);
  const bobP = await fetchPos(bob.publicKey);
  const poolA1 = await fetchPool();
  const poolDeltaA = BigInt(poolA1.baseAmountLots) - BigInt(poolA0.baseAmountLots);
  console.log(`   alice base=${aliceP.baseAmountLots}  bob base=${bobP.baseAmountLots}  pool Δ=${poolDeltaA}`);
  assert(aliceP.baseAmountLots.toString() === "1", "alice is LONG 1 (filled)");
  assert(bobP.baseAmountLots.toString() === "-1", "bob is SHORT 1 (filled)");
  assert(poolDeltaA.toString() === "0", "pool untouched (balanced peer match)");
  const aliceUcBefore = BigInt((await fetchUc(alice.publicKey)).balance.toString());
  await closePos(alice);
  await closePos(bob);
  const aliceUcAfter = BigInt((await fetchUc(alice.publicKey)).balance.toString());
  const aliceClosedP = await connection.getAccountInfo(derivePositionPda(market, alice.publicKey, program.programId)[0]);
  console.log(`   closed both — alice collateral ${aliceUcBefore}→${aliceUcAfter} (margin released)`);
  assert(aliceUcAfter > aliceUcBefore, "alice collateral credited on close (margin + PnL released)");
  assert(BigInt((await fetchPos(alice.publicKey)).baseAmountLots.toString()) === 0n, "alice position flat after close");

  // ===== Scenario B: lone long -> fills against the pool (no brick) =====
  console.log("\n=== Scenario B: LONE long → fills against the pool (no brick) ===");
  const carol = kp("carol");
  await fundDeposit(carol, DEP);
  console.log("   funded + deposited carol");
  const poolB0 = await fetchPool();
  const idB = await batchId();
  await submit(carol, 0n, 1n);
  console.log("   submitted carol LONG 1 (alone) — waiting for window + crank + MPC settle…");
  await waitWindowClose();
  if (process.env.KEEPER_DRIVEN) {
    console.log("   (KEEPER_DRIVEN) window closed — leaving the crank to the keeper bot…");
  } else {
    await crank();
  }
  await waitSettle(idB);
  const carolP = await fetchPos(carol.publicKey);
  const poolB1 = await fetchPool();
  const poolDeltaB = BigInt(poolB1.baseAmountLots) - BigInt(poolB0.baseAmountLots);
  console.log(`   carol base=${carolP.baseAmountLots}  pool base ${poolB0.baseAmountLots}→${poolB1.baseAmountLots} (Δ=${poolDeltaB})`);
  assert(carolP.baseAmountLots.toString() === "1", "carol is LONG 1 (filled against pool, not bricked)");
  assert(poolDeltaB.toString() === "-1", "pool absorbed it (went SHORT 1)");
  await closePos(carol);
  assert(BigInt((await fetchPos(carol.publicKey)).baseAmountLots.toString()) === 0n, "carol position flat after close");

  console.log(`\n✅ DEVNET E2E PASSED — ${passed} assertions across 2 scenarios (real Pyth, MPC match, pool backstop, close).`);
}

main().catch((e) => {
  console.error("\n❌ DEVNET E2E FAILED:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
