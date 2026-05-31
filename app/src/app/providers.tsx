"use client";
// Client provider stack scoped to /trade so marketing pages skip the Solana bundle.
// LocalBurnerWalletAdapter is the localnet wallet (persistent burner, faucet-funded).
import "@/lib/polyfills";
import "@solana/wallet-adapter-react-ui/styles.css";

import { useMemo, useState, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { LocalBurnerWalletAdapter } from "@/lib/localBurnerWallet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RPC_URL } from "@/lib/config";

export function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new LocalBurnerWalletAdapter()], []);
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
