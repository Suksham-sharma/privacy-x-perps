// Localnet faucet. POST { wallet } → airdrops gas SOL + mints test USDC to the
// wallet's ATA, using the localnet mint-authority keypair from FAUCET_ADMIN_SECRET
// (server-only env, written by scripts/localnet-bootstrap.ts). Node runtime: this
// handler signs transactions, so it needs a real Keypair + Node crypto. Mirrors
// the fund path in scripts/lifecycle-driver.ts.
import { NextResponse } from "next/server";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

export const runtime = "nodejs";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const USDC_DECIMALS = 6;
const FAUCET_USDC = 1_000; // test USDC per call
const FAUCET_SOL = 2; // gas for the burner to sign deposit/withdraw
const RATE_MS = 15_000;

// Per-wallet rate limit (in-memory; fine for a single-instance localnet demo).
const lastHit = new Map<string, number>();

function faucetAdmin(): Keypair {
  const secret = process.env.FAUCET_ADMIN_SECRET;
  if (!secret) {
    throw new Error("FAUCET_ADMIN_SECRET not set — run scripts/localnet-bootstrap.ts");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
}

function usdcMint(): PublicKey {
  const m = process.env.NEXT_PUBLIC_USDC_MINT;
  if (!m) {
    throw new Error("NEXT_PUBLIC_USDC_MINT not set — run scripts/localnet-bootstrap.ts");
  }
  return new PublicKey(m);
}

export async function POST(req: Request) {
  let wallet: PublicKey;
  try {
    const body = (await req.json()) as { wallet?: string };
    wallet = new PublicKey(body.wallet!);
  } catch {
    return NextResponse.json({ error: "invalid wallet" }, { status: 400 });
  }

  const key = wallet.toBase58();
  const now = Date.now();
  const prev = lastHit.get(key) ?? 0;
  if (now - prev < RATE_MS) {
    const wait = Math.ceil((RATE_MS - (now - prev)) / 1000);
    return NextResponse.json({ error: `rate limited — wait ${wait}s` }, { status: 429 });
  }
  lastHit.set(key, now);

  try {
    const conn = new Connection(RPC, "confirmed");
    const admin = faucetAdmin();
    const mint = usdcMint();

    // Gas first, so the burner can sign its own deposit/withdraw txs.
    if ((await conn.getBalance(wallet)) < FAUCET_SOL * 1e9) {
      const sig = await conn.requestAirdrop(wallet, FAUCET_SOL * 1e9);
      await conn.confirmTransaction(sig, "confirmed");
    }

    const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, wallet);
    const sig = await mintTo(
      conn,
      admin,
      mint,
      ata.address,
      admin,
      FAUCET_USDC * 10 ** USDC_DECIMALS,
    );

    return NextResponse.json({
      sig,
      ata: ata.address.toBase58(),
      usdc: FAUCET_USDC,
    });
  } catch (e) {
    lastHit.delete(key); // let the user retry after a real failure
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
