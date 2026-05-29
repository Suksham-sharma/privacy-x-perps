"use client";
// Reads the rolling BatchBuffer: how many orders are queued (n_orders/8), the
// current batch id, and whether the keeper is mid-match (is_processing). Polls
// every 2.5s so the order ticket + batch chip reflect submissions promptly.
import { useQuery } from "@tanstack/react-query";
import { deriveMarketPda, deriveBatchBufferPda } from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { PROGRAM_ID } from "@/lib/config";

export interface BatchState {
  nOrders: number;
  batchId: bigint;
  isProcessing: boolean;
  owners: string[]; // base58 owners of the queued orders (plaintext on-chain)
}

export function useBatchBuffer() {
  const program = useProgram();

  return useQuery({
    queryKey: ["batchBuffer"],
    enabled: !!program,
    refetchInterval: 2500,
    queryFn: async (): Promise<BatchState | null> => {
      const [market] = deriveMarketPda(PROGRAM_ID);
      const [bb] = deriveBatchBufferPda(market, PROGRAM_ID);
      const acc = await (program!.account as any).batchBuffer.fetchNullable(bb);
      if (!acc) return null;
      return {
        nOrders: acc.nOrders,
        batchId: BigInt(acc.batchId.toString()),
        isProcessing: acc.isProcessing,
        owners: acc.orders
          .slice(0, acc.nOrders)
          .map((o: any) => o.owner.toBase58()),
      };
    },
  });
}
