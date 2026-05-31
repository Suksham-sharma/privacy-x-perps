"use client";
// Session-scoped settlement log. Subscribes to BatchSettledEvent: on each
// keeper-cranked MPC match we (1) invalidate position/collateral/batch queries so
// the UI refreshes instantly, and (2) prepend the fill to an in-memory list that
// feeds the History tab + the fill banner. The WS subscription is best-effort —
// the polling in the data hooks is the safety net if an event is missed.
//
// HONEST SCOPE: this list lives in memory and empties on reload. A *persistent*
// history needs an indexer scanning BatchSettledEvent (or the wallet's tx log) —
// tracked as a follow-up; the History tab states this in-place.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useProgram } from "@/lib/anchor";

export interface Fill {
  batchId: bigint;
  clearingPrice: bigint;
  youFilled: boolean;
  ts: number; // epoch ms, for "x ago" labels
}

export function useFillHistory(): Fill[] {
  const program = useProgram();
  const { publicKey } = useWallet();
  const qc = useQueryClient();
  const [fills, setFills] = useState<Fill[]>([]);

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
          Array.isArray(e.filledOwners) &&
          e.filledOwners.some((o: any) => o?.equals?.(publicKey));
        const fill: Fill = {
          batchId: BigInt(e.batchId.toString()),
          clearingPrice: BigInt(e.clearingPrice.toString()),
          youFilled: !!you,
          ts: Date.now(),
        };
        setFills((prev) => {
          // de-dupe if the same batch settles twice via WS + replay
          if (prev[0] && prev[0].batchId === fill.batchId) return prev;
          return [fill, ...prev].slice(0, 50);
        });
      });
    } catch {
      return;
    }
    return () => {
      if (id !== undefined) program.removeEventListener(id);
    };
  }, [program, publicKey, qc]);

  return fills;
}
