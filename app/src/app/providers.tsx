"use client";
// Client provider stack for the /trade screen:
//   ConnectionProvider -> WalletProvider -> WalletModalProvider -> QueryClient.
// Scoped to the /trade segment (via trade/layout.tsx) so the marketing pages
// never load the Solana/wallet bundle. UnsafeBurnerWalletAdapter is the
// localnet wallet (faucet funds it); Phantom/Solflare auto-register as Wallet
// Standard wallets for the devnet flip — no explicit adapter import needed.
import "@/lib/polyfills";
import "@solana/wallet-adapter-react-ui/styles.css";

import { useMemo, useState, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RPC_URL } from "@/lib/config";

export function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new UnsafeBurnerWalletAdapter()], []);
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
