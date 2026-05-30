"use client";
// Reads the rolling BatchBuffer: how many orders are queued (n_orders/8), the
// current batch id, and whether the keeper is mid-match (is_processing). Polls
// every 2.5s so the order ticket + batch chip reflect submissions promptly.
import { useQuery } from "@tanstack/react-query";
import { deriveMarketPda, deriveBatchBufferPda } from "@confidential-perps/sdk";
import { useProgram } from "@/lib/anchor";
import { PROGRAM_ID } from "@/lib/config";

export interface BatchSlot {
  owner: string; // base58 — public on-chain
  maxMargin: bigint; // public locked margin; side/price/size stay encrypted
}

export interface BatchState {
  nOrders: number;
  batchId: bigint;
  isProcessing: boolean;
  orders: BatchSlot[]; // the queued slots (owner + margin are plaintext)
  owners: string[]; // base58 owners, for quick membership checks
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
      const orders: BatchSlot[] = acc.orders
        .slice(0, acc.nOrders)
        .map((o: any) => ({
          owner: o.owner.toBase58(),
          maxMargin: BigInt(o.maxMargin.toString()),
        }));
      return {
        nOrders: acc.nOrders,
        batchId: BigInt(acc.batchId.toString()),
        isProcessing: acc.isProcessing,
        orders,
        owners: orders.map((o) => o.owner),
      };
    },
  });
}
