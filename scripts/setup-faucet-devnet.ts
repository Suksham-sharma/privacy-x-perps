// One-time devnet faucet setup: creates a dedicated faucet keypair, funds it with SOL from the admin
// wallet, and transfers the USDC mint authority (9oCp3q…) from admin -> faucet. The faucet key is what
// the app's /api/faucet route uses to mint test USDC — keeping the 50-SOL admin wallet out of the app.
// Saves the keypair to ~/.config/solana/iceberg-faucet-devnet.json and prints FAUCET_ADMIN_SECRET.
// Run: SOLANA_RPC_URL=<helius> pnpm exec tsx scripts/setup-faucet-devnet.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { setAuthority, AuthorityType, getMint } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MINT = new PublicKey(
  process.env.USDC_MINT ?? "9oCp3qLSCrGWs97b6Mq9MVMUsRgBw3tSRtfPtT2XA9tR",
);
const FUND_SOL = Number(process.env.FAUCET_FUND_SOL ?? 10);

async function main() {
  const adminPath =
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(adminPath, "utf8"))),
  );
  const conn = new Connection(RPC, "confirmed");

  console.log("RPC          :", RPC.replace(/api-key=[^&]+/, "api-key=***"));
  console.log("Admin        :", admin.publicKey.toBase58());
  console.log("Mint         :", MINT.toBase58());

  // Reuse an existing faucet keypair if one was already created (idempotent).
  const faucetKpPath = path.join(os.homedir(), ".config/solana/iceberg-faucet-devnet.json");
  let faucet: Keypair;
  if (fs.existsSync(faucetKpPath)) {
    faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(faucetKpPath, "utf8"))));
    console.log("Faucet       :", faucet.publicKey.toBase58(), "(reused existing keypair)");
  } else {
    faucet = Keypair.generate();
    fs.writeFileSync(faucetKpPath, JSON.stringify(Array.from(faucet.secretKey)));
    console.log("Faucet       :", faucet.publicKey.toBase58(), "(new)");
  }
  console.log("Keypair file :", faucetKpPath);

  // Verify admin currently holds the mint authority before we move it.
  const before = await getMint(conn, MINT);
  if (!before.mintAuthority) throw new Error("Mint has no mint authority (frozen/renounced)");
  const adminIsAuthority = before.mintAuthority.equals(admin.publicKey);
  const faucetAlreadyAuthority = before.mintAuthority.equals(faucet.publicKey);
  console.log("Current auth :", before.mintAuthority.toBase58());

  // 1. Fund the faucet keypair.
  const faucetBal = await conn.getBalance(faucet.publicKey);
  if (faucetBal < FUND_SOL * LAMPORTS_PER_SOL) {
    const need = FUND_SOL * LAMPORTS_PER_SOL - faucetBal;
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: faucet.publicKey,
          lamports: need,
        }),
      ),
      [admin],
      { commitment: "confirmed" },
    );
    console.log(`Funded faucet -> ${FUND_SOL} SOL  tx ${sig}`);
  } else {
    console.log(`Faucet already funded (${(faucetBal / LAMPORTS_PER_SOL).toFixed(3)} SOL) — skip`);
  }

  // 2. Transfer mint authority admin -> faucet.
  if (faucetAlreadyAuthority) {
    console.log("Mint authority already = faucet — skip");
  } else if (adminIsAuthority) {
    const sig = await setAuthority(
      conn,
      admin, // payer
      MINT,
      admin, // current authority
      AuthorityType.MintTokens,
      faucet.publicKey, // new authority
    );
    console.log("Mint authority admin -> faucet  tx", sig);
  } else {
    throw new Error(
      `Admin is not the mint authority (${before.mintAuthority.toBase58()}); cannot transfer.`,
    );
  }

  // 3. Verify.
  const after = await getMint(conn, MINT);
  const bal = await conn.getBalance(faucet.publicKey);
  console.log("\n=== VERIFY ===");
  console.log(
    "mint authority:",
    after.mintAuthority?.toBase58(),
    after.mintAuthority?.equals(faucet.publicKey) ? "✓ faucet" : "✗ MISMATCH",
  );
  console.log("faucet balance:", (bal / LAMPORTS_PER_SOL).toFixed(3), "SOL");
  console.log("\nFAUCET_ADMIN_SECRET=[" + Array.from(faucet.secretKey).join(",") + "]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
