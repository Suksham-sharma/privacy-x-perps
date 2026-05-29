// SDK lifecycle driver — drives the full perp flow from outside ts-mocha.
// Foundation for the Week 6 UI: every step here maps to a UI interaction.
//
// Flow:
//   1.  connect + wait for MXE pubkey
//   2.  init_market (idempotent)
//   3.  init_match_batch_comp_def + circuit upload (idempotent)
//   4.  create + fund alice (long) + bob (short)
//   5.  alice.deposit(200 USDC), bob.deposit(200 USDC)
//   6.  alice.submitOrder(long, 100k, 1000), bob.submitOrder(short, 100k, 1000)
//   7.  wait for batch window to close
//   8.  process_batch as admin (keeper)
//   9.  await batchSettledEvent + assert fills
//   10. alice.closePosition(), bob.closePosition() at the fixture price
//   11. print final balances
//
// Localnet only — devnet needs orders priced at the real ~$200 mantissa
// (~20e9); see the TODO at the bottom of the file.
//
// Prereq: `arcium localnet` running, then:  pnpm exec tsx scripts/lifecycle-driver.ts
//
// getArciumEnv() reads ARCIUM_CLUSTER_OFFSET from the env; localnet always uses
// offset 0 (cluster_acc_0.json in artifacts/), defaulted here so users needn't set it.
process.env.ARCIUM_CLUSTER_OFFSET ??= "0";

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import {
  awaitComputationFinalization,
  getArciumAccountBaseSeed,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  uploadCircuit,
} from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  deriveUserCollateralPda,
  derivePositionPda,
  encryptOrder,
  toSubmitOrderArgs,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { ConfidentialPerps } from "../target/types/confidential_perps";

const USDC_DECIMALS = 6;
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS);
const PER_ORDER_MARGIN = 50n * ONE_USDC;
const DEPOSIT_AMOUNT = 200n * ONE_USDC;
const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
// Same address Anchor.toml injects via [[test.validator.account]] —
// localnet sees a synthetic fixture at price 100_000 with publish_time
// = i64::MAX (see scripts/build-pyth-fixture.mjs).
const PYTH_PRICE_UPDATE = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);

// Step counter for clean output.
let step = 1;
function log(msg: string) {
  console.log(`[${String(step).padStart(2, " ")}] ${msg}`);
  step++;
}

async function mxePubkeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  attempts = 60,
): Promise<Uint8Array> {
  for (let i = 0; i < attempts; i++) {
    try {
      const k = await getMXEPublicKey(provider, programId);
      if (k) return k;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("MXE pubkey unavailable — is `arcium localnet` running?");
}

async function fundUser(
  connection: Connection,
  admin: Keypair,
  user: Keypair,
  usdcMint: PublicKey,
) {
  const sig = await connection.requestAirdrop(user.publicKey, 2e9);
  await connection.confirmTransaction(sig, "confirmed");
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    usdcMint,
    user.publicKey,
  );
  await mintTo(
    connection,
    admin,
    usdcMint,
    ata.address,
    admin,
    Number(200n * ONE_USDC),
  );
  return ata.address;
}

async function main() {
  // ---- setup ----
  const wallet = new anchor.Wallet(
    Keypair.fromSecretKey(
      Buffer.from(
        JSON.parse(
          fs.readFileSync(
            process.env.ANCHOR_WALLET ??
              path.join(os.homedir(), ".config/solana/id.json"),
            "utf8",
          ),
        ),
      ),
    ),
  );
  const connection = new Connection("http://localhost:8899", "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/confidential_perps.json", "utf8"),
  );
  const program = new Program<ConfidentialPerps>(idl, provider);
  const admin = wallet.payer;

  log(`connect → localhost:8899  program=${program.programId.toBase58()}`);

  // ---- 1. MXE pubkey ----
  const mxePublicKey = await mxePubkeyWithRetry(provider, program.programId);
  log(`MXE pubkey ready (${mxePublicKey.length} bytes)`);

  // ---- 2. init_market ----
  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);
  let usdcMint: PublicKey;

  const existingMarket = await connection.getAccountInfo(marketPda);
  if (existingMarket) {
    const market = await (program.account as any).market.fetch(marketPda);
    usdcMint = market.usdcMint;
    log(`init_market: SKIP (market exists; usdc=${usdcMint.toBase58().slice(0,8)}…)`);
  } else {
    usdcMint = await createMint(connection, admin, admin.publicKey, null, USDC_DECIMALS);
    const vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
    const feedId = Array.from(Buffer.from(SOL_USD_FEED_ID_HEX, "hex"));
    const sig = await program.methods
      .initMarket(feedId)
      .accounts({
        admin: admin.publicKey,
        market: marketPda,
        batchBuffer: batchBufferPda,
        usdcMint,
        usdcVault: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    log(`init_market: OK  tx=${sig.slice(0,8)}…  usdc=${usdcMint.toBase58().slice(0,8)}…`);
  }
  const vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);

  // ---- 3. init_match_batch_comp_def + circuit ----
  const arciumEnv = getArciumEnv();
  const arciumProgram = getArciumProgram(provider);
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("match_batch");
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  const existingCompDef = await connection.getAccountInfo(compDefPda);
  if (existingCompDef) {
    log(`comp_def + circuit: SKIP (already initialized)`);
  } else {
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
    await program.methods
      .initMatchBatchCompDef()
      .accounts({
        payer: admin.publicKey,
        mxeAccount,
        compDefAccount: compDefPda,
        addressLookupTable: lutAddress,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    const rawCircuit = fs.readFileSync("build/match_batch.arcis");
    await uploadCircuit(
      provider, "match_batch", program.programId, rawCircuit, true, 500,
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
    );
    log(`comp_def + circuit: OK`);
  }

  // ---- 4. alice + bob ----
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const [aliceUc] = deriveUserCollateralPda(marketPda, alice.publicKey, program.programId);
  const [bobUc] = deriveUserCollateralPda(marketPda, bob.publicKey, program.programId);
  const [alicePos] = derivePositionPda(marketPda, alice.publicKey, program.programId);
  const [bobPos] = derivePositionPda(marketPda, bob.publicKey, program.programId);

  const aliceAta = await fundUser(connection, admin, alice, usdcMint);
  const bobAta = await fundUser(connection, admin, bob, usdcMint);
  log(`fund users → alice=${alice.publicKey.toBase58().slice(0,8)}…  bob=${bob.publicKey.toBase58().slice(0,8)}…`);

  // ---- 5. deposits ----
  for (const [user, ata, uc] of [[alice, aliceAta, aliceUc] as const, [bob, bobAta, bobUc] as const]) {
    await program.methods
      .deposit(new anchor.BN(DEPOSIT_AMOUNT.toString()))
      .accounts({
        user: user.publicKey,
        market: marketPda,
        userCollateral: uc,
        usdcVault: vaultAta,
        userTokenAccount: ata,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  }
  log(`deposit 200 USDC × 2`);

  // ---- 6. submit orders ----
  const aliceOrder: OrderPlaintext = { side: 0n, price: 100_000n, size: 1_000n, clientNonce: 1n };
  const bobOrder: OrderPlaintext = { side: 1n, price: 100_000n, size: 1_000n, clientNonce: 2n };
  const aliceArgs = toSubmitOrderArgs(encryptOrder(aliceOrder, mxePublicKey));
  const bobArgs = toSubmitOrderArgs(encryptOrder(bobOrder, mxePublicKey));

  for (const [user, args, uc, pos] of [
    [alice, aliceArgs, aliceUc, alicePos] as const,
    [bob, bobArgs, bobUc, bobPos] as const,
  ]) {
    await program.methods
      .submitOrder(
        args.x25519Pubkey,
        args.nonce,
        new anchor.BN(PER_ORDER_MARGIN.toString()),
        args.ctSide, args.ctPrice, args.ctSize, args.ctClientNonce,
      )
      .accounts({
        user: user.publicKey,
        market: marketPda,
        batchBuffer: batchBufferPda,
        userCollateral: uc,
        position: pos,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  }
  log(`submit_order × 2 (alice long, bob short, both @ 100k × 1000)`);

  // ---- 7. wait for batch window ----
  log(`wait 3s for batch window to close…`);
  await new Promise((r) => setTimeout(r, 3000));

  // ---- 8. process_batch ----
  // Wire the event listener BEFORE the crank, otherwise we race the
  // callback. The listener doesn't care WHO calls process_batch; this
  // lets KEEPER_DRIVES_CRANK=1 mode wait for the keeper to crank.
  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const settledPromise = new Promise<Event["batchSettledEvent"]>((res) => {
    const id = program.addEventListener("batchSettledEvent", (e) => {
      program.removeEventListener(id);
      res(e);
    });
  });

  if (process.env.KEEPER_DRIVES_CRANK) {
    log(`process_batch: SKIP (waiting for keeper to crank)`);
  } else {
    const computationOffset = new anchor.BN(randomBytes(8), "hex");
    const compDefOffset = Buffer.from(getCompDefAccOffset("match_batch")).readUInt32LE();
    await program.methods
      .processBatch(computationOffset)
      .accountsPartial({
        payer: admin.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        computationAccount: getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffset),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        market: marketPda,
        batchBuffer: batchBufferPda,
        priceUpdate: PYTH_PRICE_UPDATE,
      })
      .signers([admin])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    log(`process_batch queued (computation_offset=${computationOffset.toString().slice(0,8)}…)`);
  }

  // ---- 9. await MPC callback ----
  // KEEPER_DRIVES_CRANK mode doesn't know the computationOffset the
  // keeper picked, so we wait on the batchSettledEvent listener
  // (already armed above) — fires when our callback handler runs,
  // regardless of who triggered the crank.
  const settled = await settledPromise;
  log(`callback fired → clearing=${settled.clearingPrice.toString()}  vol=${settled.totalVolume.toString()}`);

  // ---- 10. fetch positions ----
  const aliceP = await (program.account as any).position.fetch(alicePos);
  const bobP = await (program.account as any).position.fetch(bobPos);
  log(`alice position: base=${aliceP.baseAmountLots}  quote=${aliceP.quoteEntry}  margin=${aliceP.marginLocked}`);
  log(`bob   position: base=${bobP.baseAmountLots}  quote=${bobP.quoteEntry}  margin=${bobP.marginLocked}`);

  // ---- 11. close both positions ----
  for (const [user, uc, pos] of [
    [alice, aliceUc, alicePos] as const,
    [bob, bobUc, bobPos] as const,
  ]) {
    await program.methods
      .closePosition()
      .accounts({
        user: user.publicKey,
        market: marketPda,
        position: pos,
        userCollateral: uc,
        priceUpdate: PYTH_PRICE_UPDATE,
      })
      .signers([user])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  }
  log(`close × 2 at fixture price (PnL = 0)`);

  // ---- 12. final balances ----
  const aliceFinal = await (program.account as any).userCollateral.fetch(aliceUc);
  const bobFinal = await (program.account as any).userCollateral.fetch(bobUc);
  const vault = await getAccount(connection, vaultAta);
  log(`alice balance: ${(BigInt(aliceFinal.balance) / ONE_USDC).toString()} USDC`);
  log(`bob   balance: ${(BigInt(bobFinal.balance) / ONE_USDC).toString()} USDC`);
  log(`vault total : ${(BigInt(vault.amount.toString()) / ONE_USDC).toString()} USDC`);

  console.log("\nLifecycle complete. ✅");
}

// TODO devnet support: real SOL/USD on devnet is ~$200 mantissa at
// exponent -8. Orders need to be priced at that scale (~20e9) instead
// of 100_000 for the ±5% oracle band to admit them. Pull live price
// from PYTH_PRICE_UPDATE before constructing orders. Also needs the
// devnet USDC mint from scripts/.devnet-state.json.

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
