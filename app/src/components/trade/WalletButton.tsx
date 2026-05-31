"use client";
// Custom connect button (Declassified-styled) using the adapter's modal + useWallet.
// On localnet the UnsafeBurnerWallet is the only choice; selecting it persists (autoConnect).
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";

export function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();

  if (publicKey) {
    const a = publicKey.toBase58();
    return (
      <button className="tbar-wallet" onClick={() => disconnect()} title="Disconnect">
        <span className="dot" /> {a.slice(0, 4)}…{a.slice(-4)}
      </button>
    );
  }

  return (
    <button className="tbar-wallet connect" onClick={() => setVisible(true)} disabled={connecting}>
      {connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}
