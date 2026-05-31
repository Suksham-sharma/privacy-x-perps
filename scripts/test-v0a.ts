// v0a pool-backstop e2e (keeper-driven): scenario B (lone order fills the pool, no brick) + C (2 long+1 short
// → 3 fills, pool takes net 1). Requires `arcium localnet` + localnet-bootstrap + keeper. Run: pnpm exec tsx scripts/test-v0a.ts
process.env.ARCIUM_CLUSTER_OFFSET ??= "0";

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { getMXEPublicKey } from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
  derivePositionPda,
  derivePoolPda,
  deriveMockOraclePda,
  encryptOrder,
  toSubmitOrderArgs,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import { ConfidentialPerps } from "../target/types/confidential_perps";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const ONE_USDC = 1_000_000n;
const faucetAdmin = Keypair.fromSeed(
  createHash("sha256").update("iceberg-localnet-faucet-v0").digest().subarray(0, 32),
);
// Per-run salt so each invocation uses fresh wallets (no stale positions).
const RUN = Date.now().toString(36);
function wallet(name: string): Keypair {
  return Keypair.fromSeed(
    createHash("sha256").update(`v0a-${RUN}-${name}`).digest().subarray(0, 32),
  );
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("   ✓ " + msg);
}

async function main() {
  const admin = Keypair.fromSecretKey(
    Buffer.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANCHOR_WALLET ??
            path.join(os.homedir(), ".config/solana/id.json"),
          "utf8",
        ),
      ),
    ),
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/confidential_perps.json", "utf8"));
  const program = new Program<ConfidentialPerps>(idl, provider);

  const mxe = await getMXEPublicKey(provider, program.programId);
  if (!mxe) throw new Error("MXE pubkey unavailable — is localnet up + bootstrapped?");

  const [market] = deriveMarketPda(program.programId);
  const [batchBuffer] = deriveBatchBufferPda(market, program.programId);
  const [poolPda] = derivePoolPda(market, program.programId);
  const [oraclePda] = deriveMockOraclePda(program.programId);

  const poolExists = await connection.getAccountInfo(poolPda);
  if (!poolExists) throw new Error("pool not funded — run scripts/localnet-bootstrap.ts");

  const marketAcc = await (program.account as any).market.fetch(market);
  const usdcMint: PublicKey = marketAcc.usdcMint;
  const oracleAcc = await connection.getAccountInfo(oraclePda);
  if (!oracleAcc) throw new Error("mock oracle not seeded — run bootstrap");
  const price = BigInt(
    oracleAcc.data.readBigInt64LE(oracleAcc.data[40] === 1 ? 73 : 74).toString(),
  );
  console.log(
    `oracle = $${(Number(price) / 1e6).toFixed(2)}  pool=${poolPda.toBase58().slice(0, 8)}…  run=${RUN}`,
  );

  const vaultAta = await getAssociatedTokenAddress(usdcMint, market, true);
  const fetchPool = () => (program.account as any).pool.fetch(poolPda);
  const fetchPos = (u: Keypair) =>
    (program.account as any).position.fetch(
      derivePositionPda(market, u.publicKey, program.programId)[0],
    );

  async function fundDeposit(u: Keypair, usdc: bigint) {
    if ((await connection.getBalance(u.publicKey)) < 1e9) {
      const s = await connection.requestAirdrop(u.publicKey, 2e9);
      await connection.confirmTransaction(s, "confirmed");
    }
    const ata = await getOrCreateAssociatedTokenAccount(connection, faucetAdmin, usdcMint, u.publicKey);
    await mintTo(connection, faucetAdmin, usdcMint, ata.address, faucetAdmin, Number(usdc));
    const [uc] = deriveUserCollateralPda(market, u.publicKey, program.programId);
    await program.methods
      .deposit(new anchor.BN(usdc.toString()))
      .accounts({
        user: u.publicKey,
        market,
        userCollateral: uc,
        usdcVault: vaultAta,
        userTokenAccount: ata.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([u])
      .rpc({ commitment: "confirmed" });
  }

  let nonceCtr = 1n;
  async function submit(u: Keypair, side: bigint, size: bigint) {
    // Long ABOVE / short BELOW oracle so it crosses despite the keeper pushing fresh prices;
    // clearing is always the crank-time oracle, so this affects the cross gate only, not PnL.
    const orderPrice = side === 0n ? price + price / 50n : price - price / 50n;
    const margin = orderPrice * size; // ~1x margin (full notional) — liquidation-safe
    const [uc] = deriveUserCollateralPda(market, u.publicKey, program.programId);
    const [pos] = derivePositionPda(market, u.publicKey, program.programId);
    const pt: OrderPlaintext = { side, price: orderPrice, size, clientNonce: nonceCtr++ };
    const args = toSubmitOrderArgs(encryptOrder(pt, mxe));
    await program.methods
      .submitOrder(
        args.x25519Pubkey,
        args.nonce,
        new anchor.BN(margin.toString()),
        args.ctSide,
        args.ctPrice,
        args.ctSize,
        args.ctClientNonce,
      )
      .accounts({
        user: u.publicKey,
        market,
        batchBuffer,
        userCollateral: uc,
        position: pos,
        systemProgram: SystemProgram.programId,
      })
      .signers([u])
      .rpc({ commitment: "confirmed" });
  }

  function awaitSettle(timeoutMs = 120_000): Promise<any> {
    return new Promise((res, rej) => {
      const id = program.addEventListener("batchSettledEvent", (e: any) => {
        program.removeEventListener(id);
        clearTimeout(t);
        res(e);
      });
      const t = setTimeout(() => {
        program.removeEventListener(id);
        rej(new Error("timed out waiting for BatchSettledEvent — is the keeper running?"));
      }, timeoutMs);
    });
  }

  // ---- Scenario B: lone order fills against the pool ----
  console.log("\n=== Scenario B: LONE long order → fills against the pool ===");
  const carol = wallet("carol");
  await fundDeposit(carol, price + 50n * ONE_USDC);
  const poolB0 = await fetchPool();
  const settledB = awaitSettle();
  await submit(carol, 0n, 1n);
  console.log("   carol submitted lone LONG 1 — waiting for keeper crank + settle…");
  const eB = await settledB;
  await new Promise((r) => setTimeout(r, 2500)); // let "confirmed" reads catch up to the WS event
  const carolPos = await fetchPos(carol);
  const poolB1 = await fetchPool();
  const poolDeltaB = BigInt(poolB1.baseAmountLots) - BigInt(poolB0.baseAmountLots);
  console.log(
    `   settled: long=${eB.totalLongBase} short=${eB.totalShortBase} pool_base=${eB.poolBase} filled=${eB.filledOwners.length}`,
  );
  console.log(`   carol base=${carolPos.baseAmountLots}  pool base ${poolB0.baseAmountLots}→${poolB1.baseAmountLots}`);
  assert(carolPos.baseAmountLots.toString() === "1", "carol is LONG 1 (filled, not bricked)");
  assert(poolDeltaB.toString() === "-1", "pool went SHORT 1 (absorbed the lone long)");
  assert(eB.filledOwners.length === 1, "exactly 1 trader filled");

  // ---- Scenario C: imbalanced batch (2 long + 1 short) ----
  console.log("\n=== Scenario C: 2 long + 1 short → 3 fills, pool takes net 1 short ===");
  const dave = wallet("dave");
  const erin = wallet("erin");
  const frank = wallet("frank");
  for (const w of [dave, erin, frank]) await fundDeposit(w, price + 50n * ONE_USDC);
  const poolC0 = await fetchPool();
  const settledC = awaitSettle();
  await submit(dave, 0n, 1n); // long
  await submit(erin, 0n, 1n); // long
  await submit(frank, 1n, 1n); // short
  console.log("   dave+erin LONG, frank SHORT submitted — waiting…");
  const eC = await settledC;
  await new Promise((r) => setTimeout(r, 2500)); // let "confirmed" reads catch up to the WS event
  const poolC1 = await fetchPool();
  const poolDeltaC = BigInt(poolC1.baseAmountLots) - BigInt(poolC0.baseAmountLots);
  const [davP, errP, frkP] = [await fetchPos(dave), await fetchPos(erin), await fetchPos(frank)];
  console.log(
    `   settled: long=${eC.totalLongBase} short=${eC.totalShortBase} pool_base=${eC.poolBase} filled=${eC.filledOwners.length}`,
  );
  console.log(`   dave=${davP.baseAmountLots} erin=${errP.baseAmountLots} frank=${frkP.baseAmountLots}  pool Δ=${poolDeltaC}`);
  assert(eC.totalLongBase.toString() === "2" && eC.totalShortBase.toString() === "1", "2 long + 1 short filled");
  assert(davP.baseAmountLots.toString() === "1" && errP.baseAmountLots.toString() === "1", "both longs are +1");
  assert(frkP.baseAmountLots.toString() === "-1", "short is -1");
  assert(poolDeltaC.toString() === "-1", "pool took net SHORT 1 (2 long − 1 short)");
  assert(eC.filledOwners.length === 3, "all 3 traders filled");

  console.log("\nv0a scenarios B + C passed ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
