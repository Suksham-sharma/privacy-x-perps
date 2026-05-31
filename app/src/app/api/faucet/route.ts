// Faucet: POST { wallet } funds gas SOL + mints test USDC, signing with the mint-authority
// keypair from FAUCET_ADMIN_SECRET (server-only env). Node runtime. Works on localnet AND
// devnet: gas is TRANSFERRED from the faucet wallet (devnet RPCs don't run an airdrop faucet).
import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getMint } from "@solana/spl-token";

export const runtime = "nodejs";

// Pull every useful field off a thrown error so the client doesn't get a blank
// message (Solana SendTransactionError leaves .message empty until getLogs()).
function errInfo(e: any) {
  return {
    name: e?.name ?? null,
    message: e?.message || null,
    detail: String(e?.message || e?.toString?.() || e || "").slice(0, 600),
    logs: e?.logs ?? null,
  };
}

// Prefer a server-only RPC (SOLANA_RPC_URL) — reliably read at runtime on Vercel —
// then the public NEXT_PUBLIC one, then localnet. The default devnet RPC rate-limits hard.
const RPC =
  process.env.SOLANA_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://api.devnet.solana.com";
const USDC_DECIMALS = 6;
const FAUCET_USDC = 1_000; // test USDC per call
const FAUCET_SOL = 0.1; // gas for the burner to sign deposit/order/close (from the faucet wallet)
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
  // Default to the devnet mint we control; localnet overrides via env.
  return new PublicKey(
    process.env.NEXT_PUBLIC_USDC_MINT ??
      "9oCp3qLSCrGWs97b6Mq9MVMUsRgBw3tSRtfPtT2XA9tR",
  );
}

// Diagnostic: GET /api/faucet shows exactly what the deployed function resolved
// (RPC host, admin pubkey + balance, mint, mint-authority match). No secrets.
export async function GET() {
  try {
    const conn = new Connection(RPC, "confirmed");
    const admin = faucetAdmin();
    const mint = usdcMint();
    const adminSol = (await conn.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL;
    let mintAuthority: string | null = null;
    try {
      mintAuthority = (await getMint(conn, mint)).mintAuthority?.toBase58() ?? null;
    } catch (e: any) {
      mintAuthority = `getMint failed: ${String(e?.message || e).slice(0, 120)}`;
    }
    return NextResponse.json({
      rpcHost: (() => { try { return new URL(RPC).host; } catch { return RPC; } })(),
      admin: admin.publicKey.toBase58(),
      adminSol,
      mint: mint.toBase58(),
      mintAuthority,
      adminIsMintAuthority: mintAuthority === admin.publicKey.toBase58(),
    });
  } catch (e) {
    return NextResponse.json({ error: errInfo(e) }, { status: 500 });
  }
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

    // Gas first, so the burner can sign its own deposit/order txs. Transfer from the
    // faucet wallet (it holds SOL + is the mint authority) — devnet has no airdrop here.
    if ((await conn.getBalance(wallet)) < FAUCET_SOL * LAMPORTS_PER_SOL) {
      await sendAndConfirmTransaction(
        conn,
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: wallet,
            lamports: Math.floor(FAUCET_SOL * LAMPORTS_PER_SOL),
          }),
        ),
        [admin],
        { commitment: "confirmed" },
      );
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
    return NextResponse.json({ error: errInfo(e) }, { status: 500 });
  }
}
