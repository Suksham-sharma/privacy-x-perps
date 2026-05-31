"use client";
// Live index price: decodes the configured PriceUpdateV2 account (PYTH_PRICE_UPDATE
// — the real Pyth SOL/USD feed on devnet, the localnet mock/fixture otherwise),
// polling 3s. Normalized to USD * 1e6 (== USDC base units per SOL) by the shared
// SDK reader, so it agrees with the on-chain oracle byte-for-byte; null until seeded.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Connection } from "@solana/web3.js";
import { readNormalizedPythPrice } from "@confidential-perps/sdk";
import { PYTH_PRICE_UPDATE, RPC_URL } from "@/lib/config";

export function useIndexPrice() {
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);

  return useQuery({
    queryKey: ["indexPrice"],
    refetchInterval: 3000,
    queryFn: async (): Promise<bigint | null> => {
      const acc = await connection.getAccountInfo(PYTH_PRICE_UPDATE);
      return readNormalizedPythPrice(acc?.data ?? null);
    },
  });
}
