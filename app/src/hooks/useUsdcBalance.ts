"use client";
// Reads the connected wallet's USDC token-account balance (the spendable USDC in
// the user's own wallet, distinct from deposited collateral), polling every 3s.
// Returns base units; 0n when the ATA doesn't exist yet.
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { USDC_MINT } from "@/lib/config";

export function useUsdcBalance() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  return useQuery({
    queryKey: ["usdcBalance", publicKey?.toBase58()],
    enabled: !!publicKey && !!USDC_MINT,
    refetchInterval: 3000,
    queryFn: async (): Promise<bigint> => {
      const ata = await getAssociatedTokenAddress(USDC_MINT!, publicKey!);
      try {
        const bal = await connection.getTokenAccountBalance(ata);
        return BigInt(bal.value.amount);
      } catch {
        return 0n; // ATA not created yet
      }
    },
  });
}
