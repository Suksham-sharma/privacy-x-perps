"use client";
// Reads the wallet's Position (plaintext in v0), polling 3s as a fallback for a
// missed settle event. base_amount_lots is signed: + long, - short; 0 = none.
import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { deriveMarketPda, derivePositionPda } from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { PROGRAM_ID } from "@/lib/config";

export interface PositionState {
  baseAmountLots: bigint; // signed
  quoteEntry: bigint;
  marginLocked: bigint;
}

export function usePosition() {
  const program = useProgram();
  const { publicKey } = useWallet();

  return useQuery({
    queryKey: ["position", publicKey?.toBase58()],
    enabled: !!program && !!publicKey,
    refetchInterval: 3000,
    queryFn: async (): Promise<PositionState | null> => {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [pos] = derivePositionPda(market, publicKey!, PROGRAM_ID);
      const acc = await (program!.account as any).position.fetchNullable(pos);
      if (!acc) return null;
      const base = BigInt(acc.baseAmountLots.toString());
      if (base === 0n) return null; // closed / never opened
      return {
        baseAmountLots: base,
        quoteEntry: BigInt(acc.quoteEntry.toString()),
        marginLocked: BigInt(acc.marginLocked.toString()),
      };
    },
  });
}
