"use client";
// Persistent localnet burner: subclasses UnsafeBurnerWalletAdapter to keep the
// secret key in localStorage so a refresh reuses the SAME wallet (and its funds,
// until localnet restarts — clear via resetLocalBurner()).
// UNSAFE, localnet/dev only: the secret key lives in the page and localStorage.
// Never use for real funds.
import { Keypair } from "@solana/web3.js";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";

const STORAGE_KEY = "iceberg.burner.secretKey";

function loadOrCreate(): Keypair {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    // corrupt/unparseable stored value — fall through to a fresh keypair
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    // private mode / storage blocked: behaves like the stock ephemeral burner
  }
  return kp;
}

// Forget the persisted burner (next connect mints a brand-new wallet).
export function resetLocalBurner(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // no storage — nothing to clear
  }
}

export class LocalBurnerWalletAdapter extends UnsafeBurnerWalletAdapter {
  // Override connect to restore the persisted keypair instead of generating a
  // fresh one. signTransaction/signMessage in the base read this._keypair.
  async connect(): Promise<void> {
    const keypair = loadOrCreate();
    (this as unknown as { _keypair: Keypair })._keypair = keypair;
    this.emit("connect", keypair.publicKey);
  }
}
