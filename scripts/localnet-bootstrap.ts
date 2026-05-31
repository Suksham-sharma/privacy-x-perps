// Localnet bootstrap for the /trade UI. Run ONCE per `arcium localnet` session:
//
//   pnpm exec tsx scripts/localnet-bootstrap.ts
//
// Mirrors lifecycle-driver.ts's init path (market + USDC mint + match comp def +
// circuit), then emits app/.env.local so the UI + faucet route are wired to this
// localnet. Localnet state is ephemeral per `arcium localnet` run; re-run this
// after restarting localnet. The faucet/mint-authority keypair is derived from a
// constant so the USDC mint authority stays stable across re-runs and restarts
// (localnet-only — it mints worthless test USDC, so it has zero security value).
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
  getMint,
  mintTo,
} from "@solana/spl-token";
import {
  getArciumProgram,
  getArciumProgramId,
  getArciumAccountBaseSeed,
  getCompDefAccOffset,
  getMXEAccAddress,
  getMXEPublicKey,
  getLookupTableAddress,
  uploadCircuit,
} from "@arcium-hq/client";
import {
  deriveMarketPda,
  deriveBatchBufferPda,
  derivePoolPda,
  deriveMockOraclePda,
} from "@confidential-perps/sdk";
import { ConfidentialPerps } from "../target/types/confidential_perps";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const USDC_DECIMALS = 6;
// Protocol liquidity backstop (v0a): the pool absorbs each batch's net
// imbalance. Funded generously vs demo order sizes (~1 SOL) so it never runs
// dry — the skew cap is the production guard (see constants.rs MAX_POOL_BASE).
const POOL_FUNDING_USDC = 100_000;
// SOL/USD Pyth feed id — same one pinned at init in lifecycle-driver / constants.
const SOL_USD_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

// Deterministic localnet faucet keypair (USDC mint authority + faucet signer).
const faucetAdmin = Keypair.fromSeed(
  createHash("sha256").update("iceberg-localnet-faucet-v0").digest().subarray(0, 32),
);

function loadAdmin(): Keypair {
  const p =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))),
  );
}

async function airdropTo(conn: Connection, pk: PublicKey, sol: number) {
  if ((await conn.getBalance(pk)) >= sol * 1e9) return;
  const sig = await conn.requestAirdrop(pk, sol * 1e9);
  await conn.confirmTransaction(sig, "confirmed");
}

async function mxeWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  attempts = 120,
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

// Live SOL/USD spot in the protocol's index units (USD * 1e6). Falls back to a
// sane localnet default so bootstrap never blocks on the network.
const PRICE_SCALE = 1_000_000;
async function fetchSolPriceUnits(): Promise<bigint> {
  try {
    const res = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
    );
    if (res.ok) {
      const j = (await res.json()) as { price?: string };
      const usd = Number(j.price);
      if (Number.isFinite(usd) && usd > 0) {
        return BigInt(Math.round(usd * PRICE_SCALE));
      }
    }
  } catch {}
  return 150n * BigInt(PRICE_SCALE); // fallback: $150.00
}

async function main() {
  const admin = loadAdmin();
  const wallet = new anchor.Wallet(admin);
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/confidential_perps.json", "utf8"),
  );
  const program = new Program<ConfidentialPerps>(idl, provider);
  console.log(`connect → ${RPC}  program=${program.programId.toBase58()}`);

  await airdropTo(connection, admin.publicKey, 10);
  await airdropTo(connection, faucetAdmin.publicKey, 100);

  const mxe = await mxeWithRetry(provider, program.programId);
  console.log(`MXE pubkey ready (${mxe.length} bytes)`);

  // ---- market + USDC mint ----
  const [marketPda] = deriveMarketPda(program.programId);
  const [batchBufferPda] = deriveBatchBufferPda(marketPda, program.programId);
  let usdcMint: PublicKey;

  const existing = await connection.getAccountInfo(marketPda);
  if (existing) {
    const market = await (program.account as any).market.fetch(marketPda);
    usdcMint = market.usdcMint;
    const mintInfo = await getMint(connection, usdcMint);
    const authOk = mintInfo.mintAuthority?.equals(faucetAdmin.publicKey);
    console.log(
      `init_market: SKIP (market exists; usdc=${usdcMint.toBase58().slice(0, 8)}…; ` +
        `faucet-authority=${authOk ? "OK" : "MISMATCH — restart `arcium localnet` for a clean bootstrap"})`,
    );
  } else {
    usdcMint = await createMint(
      connection,
      faucetAdmin,
      faucetAdmin.publicKey,
      null,
      USDC_DECIMALS,
    );
    const vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
    const feedId = Array.from(Buffer.from(SOL_USD_FEED_ID_HEX, "hex"));
    await program.methods
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
    console.log(`init_market: OK  usdc=${usdcMint.toBase58().slice(0, 8)}…`);
  }

  // ---- match comp def + circuit (idempotent) ----
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("match_batch");
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];

  if (await connection.getAccountInfo(compDefPda)) {
    console.log("comp_def + circuit: SKIP (already initialized)");
  } else {
    const arciumProgram = getArciumProgram(provider);
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
      provider,
      "match_batch",
      program.programId,
      rawCircuit,
      true,
      500,
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" },
    );
    console.log("comp_def + circuit: OK");
  }

  // ---- liquidity pool backstop (v0a) ----
  // Fund the singleton pool that backstops batch matching. Idempotent: skip if
  // it already exists (init_pool would otherwise top it up on every re-run).
  const [poolPda] = derivePoolPda(marketPda, program.programId);
  const vaultAta = await getAssociatedTokenAddress(usdcMint, marketPda, true);
  if (await connection.getAccountInfo(poolPda)) {
    console.log("init_pool: SKIP (pool already funded)");
  } else {
    // Mint the funding to the faucet admin (the mint authority), then deposit
    // it into the shared vault as the pool's protocol-owned buffer.
    const funderAta = await getOrCreateAssociatedTokenAccount(
      connection,
      faucetAdmin,
      usdcMint,
      faucetAdmin.publicKey,
    );
    const fundingBase = BigInt(POOL_FUNDING_USDC) * BigInt(10 ** USDC_DECIMALS);
    await mintTo(
      connection,
      faucetAdmin,
      usdcMint,
      funderAta.address,
      faucetAdmin,
      fundingBase,
    );
    await program.methods
      .initPool(new anchor.BN(fundingBase.toString()))
      .accounts({
        funder: faucetAdmin.publicKey,
        market: marketPda,
        pool: poolPda,
        usdcVault: vaultAta,
        funderTokenAccount: funderAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([faucetAdmin])
      .rpc({ skipPreflight: true, commitment: "confirmed" });
    console.log(`init_pool: OK  funded ${POOL_FUNDING_USDC.toLocaleString()} USDC`);
  }

  // ---- mock oracle (DEMO/LOCALNET) ----
  // Seed the program-owned mock PriceUpdateV2 with a live SOL/USD price so the
  // engine + UI read a realistic mark immediately. The keeper's pusher keeps it
  // ticking afterward. Requires the program built with feature = "mock-oracle".
  const [mockOraclePda] = deriveMockOraclePda(program.programId);
  const seedPrice = await fetchSolPriceUnits();
  await program.methods
    .setMockOracle(new anchor.BN(seedPrice.toString()))
    .accounts({
      authority: admin.publicKey,
      mockOracle: mockOraclePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  console.log(
    `mock oracle: OK  ${mockOraclePda.toBase58().slice(0, 8)}… seeded @ ` +
      `$${(Number(seedPrice) / 1e6).toFixed(2)}`,
  );

  // ---- emit app/.env.local ----
  const env =
    [
      "# Generated by scripts/localnet-bootstrap.ts — localnet wiring for /trade.",
      "# Ephemeral per `arcium localnet` run; re-run bootstrap after restarting it.",
      "# FAUCET_ADMIN_SECRET is a localnet-only mint authority (worthless test USDC).",
      `NEXT_PUBLIC_RPC_URL=${RPC}`,
      `NEXT_PUBLIC_PROGRAM_ID=${program.programId.toBase58()}`,
      "NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET=0",
      `NEXT_PUBLIC_USDC_MINT=${usdcMint.toBase58()}`,
      `NEXT_PUBLIC_PYTH_PRICE_UPDATE=${mockOraclePda.toBase58()}`,
      `FAUCET_ADMIN_SECRET=[${Array.from(faucetAdmin.secretKey).join(",")}]`,
    ].join("\n") + "\n";

  const envPath = path.join("app", ".env.local");
  fs.writeFileSync(envPath, env);
  console.log(`wrote ${envPath}`);
  console.log(
    "\nBootstrap complete. ✅  Restart the Next dev server so it picks up .env.local.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
