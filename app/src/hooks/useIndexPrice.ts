"use client";
// Live index price for the terminal. Reads the program-owned mock PriceUpdateV2
// account that the localnet keeper keeps fresh with real SOL/USD spot, decoding
// the i64 mantissa directly (same layout as programs/.../pyth.rs). Polls every
// 3s so the mark ticks with the market. Returns the price in index units
// (USD * 1e6, == USDC base units per SOL); null until the account is seeded.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Connection } from "@solana/web3.js";
import { deriveMockOraclePda } from "@confidential-perps/sdk";
import { PROGRAM_ID, RPC_URL } from "@/lib/config";

export function useIndexPrice() {
  const connection = useMemo(() => new Connection(RPC_URL, "confirmed"), []);

  return useQuery({
    queryKey: ["indexPrice"],
    refetchInterval: 3000,
    queryFn: async (): Promise<bigint | null> => {
      const [oracle] = deriveMockOraclePda(PROGRAM_ID);
      const acc = await connection.getAccountInfo(oracle);
      if (!acc || acc.data.length < 81) return null;
      const data = acc.data;
      // verification_level byte at offset 40: Full(1) → price at 73, else 74.
      const priceOffset = data[40] === 1 ? 8 + 32 + 1 + 32 : 8 + 32 + 2 + 32;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const price = dv.getBigInt64(priceOffset, true);
      return price > 0n ? price : null;
    },
  });
}
