// SDK lifecycle driver — full perp flow (init → deposit → orders → crank → settle → close) outside ts-mocha.
// Localnet only (devnet needs real ~$200-mantissa pricing; see TODO at bottom). Run: `arcium localnet`,
// then `pnpm exec tsx scripts/lifecycle-driver.ts`. ARCIUM_CLUSTER_OFFSET defaults to 0 (localnet).
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
  deriveMockOraclePda,
  encryptOrder,
  toSubmitOrderArgs,
  type OrderPlaintext,
} from "@confidential-perps/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes, createHash } from "crypto";

// Deterministic faucet keypair = the localnet USDC mint authority (set by bootstrap);
// fundUser must mint with THIS authority, not `admin`.
const faucetAdmin = Keypair.fromSeed(
  createHash("sha256").update("iceberg-localnet-faucet-v0").digest().subarray(0, 32),
);
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
  // Mint authority is the faucet admin (set by the bootstrap), not `admin`.
  await mintTo(
    connection,
    admin, // fee payer
    usdcMint,
    ata.address,
    faucetAdmin, // mint authority
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
    usdcMint = await createMint(connection, admin, faucetAdmin.publicKey, null, USDC_DECIMALS);
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
  // Price at the LIVE mock-oracle value (USD * 1e6) so both orders sit inside
  // the circuit's ±5% band; 1 lot = 1 SOL.
  const [oraclePda] = deriveMockOraclePda(program.programId);
  const oracleAcc = await connection.getAccountInfo(oraclePda);
  if (!oracleAcc) throw new Error("mock oracle not seeded — run localnet-bootstrap first");
  const livePrice = BigInt(
    oracleAcc.data.readBigInt64LE(oracleAcc.data[40] === 1 ? 73 : 74).toString(),
  );
  log(`live oracle price = $${(Number(livePrice) / 1e6).toFixed(2)} (${livePrice})`);
  // Price the long ABOVE and the short BELOW the oracle so both reliably cross
  // even as the keeper pushes a fresh oracle during the window (v0a dropped the
  // ±5% band; clearing is always the crank-time oracle regardless of these).
  const longPrice = livePrice + livePrice / 50n; // +2%
  const shortPrice = livePrice - livePrice / 50n; // -2%
  const aliceOrder: OrderPlaintext = { side: 0n, price: longPrice, size: 1n, clientNonce: 1n };
  const bobOrder: OrderPlaintext = { side: 1n, price: shortPrice, size: 1n, clientNonce: 2n };
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
  log(`submit_order × 2 (alice long, bob short, both @ live oracle × 1 SOL)`);

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
        priceUpdate: oraclePda,
      })
      .signers([admin])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    log(`process_batch queued (computation_offset=${computationOffset.toString().slice(0,8)}…)`);
  }

  // ---- 9. await MPC callback ----
  // Wait on the batchSettledEvent listener (armed above) — fires on our callback
  // regardless of who cranked, so KEEPER_DRIVES_CRANK mode needn't know the offset.
  const settled = await settledPromise;
  // The WS event can land a beat before the callback's writes are queryable at
  // "confirmed" — let the read catch up before fetching positions.
  await new Promise((r) => setTimeout(r, 2500));
  log(
    `callback fired → clearing=${settled.clearingPrice.toString()}  ` +
      `long=${settled.totalLongBase.toString()}  short=${settled.totalShortBase.toString()}  ` +
      `pool_base=${settled.poolBase.toString()}`,
  );

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
        priceUpdate: oraclePda,
      })
      .signers([user])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
  }
  log(`close × 2 at the live oracle price (realized PnL from price drift)`);

  // ---- 12. final balances ----
  const aliceFinal = await (program.account as any).userCollateral.fetch(aliceUc);
  const bobFinal = await (program.account as any).userCollateral.fetch(bobUc);
  const vault = await getAccount(connection, vaultAta);
  log(`alice balance: ${(BigInt(aliceFinal.balance) / ONE_USDC).toString()} USDC`);
  log(`bob   balance: ${(BigInt(bobFinal.balance) / ONE_USDC).toString()} USDC`);
  log(`vault total : ${(BigInt(vault.amount.toString()) / ONE_USDC).toString()} USDC`);

  console.log("\nLifecycle complete. ✅");
}

// TODO devnet support: price orders at the real ~$200 mantissa (~20e9, exp -8) pulled from
// PYTH_PRICE_UPDATE, and use the devnet USDC mint from scripts/.devnet-state.json.

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
