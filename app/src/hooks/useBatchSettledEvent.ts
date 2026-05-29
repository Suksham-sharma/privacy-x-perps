"use client";
// Subscribes to BatchSettledEvent. When the keeper-cranked MPC match settles, we
// invalidate position/collateral/batch queries (instant refresh) and surface a
// "filled @ clearing price" notice. The WS subscription is best-effort — the 3s
// polling in the data hooks is the safety net if the event is missed.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useProgram } from "@/lib/anchor";

export interface FillNotice {
  batchId: bigint;
  clearingPrice: bigint;
  youFilled: boolean;
}

export function useBatchSettledEvent(): FillNotice | null {
  const program = useProgram();
  const { publicKey } = useWallet();
  const qc = useQueryClient();
  const [fill, setFill] = useState<FillNotice | null>(null);

  useEffect(() => {
    if (!program) return;
    let id: number | undefined;
    try {
      id = program.addEventListener("batchSettledEvent", (e: any) => {
        qc.invalidateQueries({ queryKey: ["position"] });
        qc.invalidateQueries({ queryKey: ["userCollateral"] });
        qc.invalidateQueries({ queryKey: ["batchBuffer"] });
        const you =
          !!publicKey &&
          (e.ownerA?.equals?.(publicKey) || e.ownerB?.equals?.(publicKey));
        setFill({
          batchId: BigInt(e.batchId.toString()),
          clearingPrice: BigInt(e.clearingPrice.toString()),
          youFilled: !!you,
        });
      });
    } catch {
      return;
    }
    return () => {
      if (id !== undefined) program.removeEventListener(id);
    };
  }, [program, publicKey, qc]);

  return fill;
}
