// Counterparty order submitter — drives the OTHER side of a match so the browser
// wallet's order can fill. A single browser has one burner; this script plays the
// opposite side from a deterministic localnet keypair. Run after the UI submits
// an order, then start the keeper to crank.
//
//   pnpm exec tsx scripts/counterparty.ts [short|long] [size]
//
// Defaults: short 1000 @ the localnet index (100,000), 2x leverage (50 USDC margin).
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
  deriveMockOraclePda,
  encryptOrder,
  toSubmitOrderArgs,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import { ConfidentialPerps } from "../target/types/confidential_perps";
import * as fs from "fs";
import { createHash } from "crypto";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const ONE_USDC = 1_000_000n;
const PRICE = 100_000n;
const LEVERAGE = 2n;

// Same deterministic faucet/mint authority the bootstrap uses.
const faucetAdmin = Keypair.fromSeed(
  createHash("sha256").update("iceberg-localnet-faucet-v0").digest().subarray(0, 32),
);
// Deterministic counterparty wallet (localnet-only).
const counterparty = Keypair.fromSeed(
  createHash("sha256").update("iceberg-localnet-counterparty-v0").digest().subarray(0, 32),
);

async function mxeWithRetry(provider: anchor.AnchorProvider, programId: PublicKey) {
  for (let i = 0; i < 60; i++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MXE pubkey unavailable — is `arcium localnet` running?");
}

async function main() {
  const sideArg = (process.argv[2] ?? "short").toLowerCase();
  const side = sideArg === "long" ? 0n : 1n;
  const size = BigInt(process.argv[3] ?? "1"); // 1 lot = 1 SOL

  const connection = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(counterparty);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/confidential_perps.json", "utf8"));
  const program = new Program<ConfidentialPerps>(idl, provider);

  // Price at the LIVE mock-oracle value so we cross the browser order in-band.
  const [oraclePda] = deriveMockOraclePda(program.programId);
  const oracleAcc = await connection.getAccountInfo(oraclePda);
  if (!oracleAcc) throw new Error("mock oracle not seeded — run localnet-bootstrap first");
  const price = BigInt(oracleAcc.data.readBigInt64LE(oracleAcc.data[40] === 1 ? 73 : 74).toString());
  const notional = price * size;
  const maxMargin = (notional + LEVERAGE - 1n) / LEVERAGE;
  const deposit = maxMargin + 10n * ONE_USDC; // a little headroom

  console.log(
    `counterparty ${counterparty.publicKey.toBase58().slice(0, 8)}… → ${sideArg} ${size} SOL @ $${(Number(price) / 1e6).toFixed(2)}`,
  );

  // Fund SOL.
  if ((await connection.getBalance(counterparty.publicKey)) < 1e9) {
    const sig = await connection.requestAirdrop(counterparty.publicKey, 2e9);
    await connection.confirmTransaction(sig, "confirmed");
  }

  const mxe = await mxeWithRetry(provider, program.programId);

  const [market] = deriveMarketPda(program.programId);
  const [batchBuffer] = deriveBatchBufferPda(market, program.programId);
  const [userCollateral] = deriveUserCollateralPda(market, counterparty.publicKey, program.programId);
  const [position] = derivePositionPda(market, counterparty.publicKey, program.programId);
  const marketAcc = await (program.account as any).market.fetch(market);
  const usdcMint: PublicKey = marketAcc.usdcMint;

  // Mint USDC to the counterparty + deposit, if it has no collateral yet.
  const uc = await (program.account as any).userCollateral.fetchNullable(userCollateral);
  const balance = uc ? BigInt(uc.balance.toString()) : 0n;
  if (balance < maxMargin) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, faucetAdmin, usdcMint, counterparty.publicKey);
    await mintTo(connection, faucetAdmin, usdcMint, ata.address, faucetAdmin, Number(deposit));
    await program.methods
      .deposit(new anchor.BN(deposit.toString()))
      .accounts({
        user: counterparty.publicKey,
        market,
        userCollateral,
        usdcVault: await getAssociatedTokenAddress(usdcMint, market, true),
        userTokenAccount: ata.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
    console.log(`deposited ${(deposit / ONE_USDC).toString()} USDC`);
  }

  // Encrypt + submit the opposing order.
  const pt: OrderPlaintext = { side, price, size, clientNonce: 7n };
  const args = toSubmitOrderArgs(encryptOrder(pt, mxe));
  await program.methods
    .submitOrder(
      args.x25519Pubkey,
      args.nonce,
      new anchor.BN(maxMargin.toString()),
      args.ctSide,
      args.ctPrice,
      args.ctSize,
      args.ctClientNonce,
    )
    .accounts({
      user: counterparty.publicKey,
      market,
      batchBuffer,
      userCollateral,
      position,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });

  const buf = await (program.account as any).batchBuffer.fetch(batchBuffer);
  console.log(`submitted. batch #${buf.batchId.toString()} now ${buf.nOrders}/4 orders`);
  console.log("Start/await the keeper to crank process_batch.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
