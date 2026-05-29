"use client";
// Reads the connected wallet's UserCollateral.balance (deposited margin held by
// the program), polling every 3s. Returns base units (USDC has 6 decimals);
// 0n when the PDA doesn't exist yet (never deposited).
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { deriveMarketPda, deriveUserCollateralPda } from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { PROGRAM_ID } from "@/lib/config";

export function useUserCollateral() {
  const program = useProgram();
  const { publicKey } = useWallet();

  return useQuery({
    queryKey: ["userCollateral", publicKey?.toBase58()],
    enabled: !!program && !!publicKey,
    refetchInterval: 3000,
    queryFn: async (): Promise<bigint> => {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [uc] = deriveUserCollateralPda(market, publicKey!, PROGRAM_ID);
      const acc = await (program!.account as any).userCollateral.fetchNullable(uc);
      return acc ? BigInt(acc.balance.toString()) : 0n;
    },
  });
}
