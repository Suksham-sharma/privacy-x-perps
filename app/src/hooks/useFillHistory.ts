"use client";
// Session-scoped settlement log: on each MPC match, invalidate position/
// collateral/batch queries and prepend the fill to an in-memory list.
// Anchor's EventParser is flaky on Arcium's multi-ix callback txs (stack pop
// underflow drops all events), so decode "Program data:" lines directly by
// discriminator instead; polling in the data hooks is the safety net.
// HONEST SCOPE: in-memory, empties on reload — persistence needs an indexer.
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

const PROGRAM_DATA = "Program data: ";

export function useFillHistory(): Fill[] {
  const program = useProgram();
  const { publicKey } = useWallet();
  const qc = useQueryClient();
  const [fills, setFills] = useState<Fill[]>([]);

  useEffect(() => {
    if (!program) return;
    const conn = program.provider.connection;
    let subId: number | undefined;
    try {
      subId = conn.onLogs(
        program.programId,
        (logs) => {
          if (logs.err) return;
          for (const line of logs.logs) {
            if (!line.startsWith(PROGRAM_DATA)) continue;
            // Decode by discriminator: returns null for any non-matching
            // "Program data:" line (e.g. Arcium's own events), so this only
            // fires on our BatchSettledEvent.
            let decoded: { name: string; data: Record<string, unknown> } | null = null;
            try {
              decoded = program.coder.events.decode(line.slice(PROGRAM_DATA.length));
            } catch {
              continue;
            }
            // Accept BOTH name/field casings: program.coder camelCases the IDL
            // while a raw BorshCoder yields PascalCase + snake_case — coalesce
            // so a casing change can't silently stop capturing fills again.
            if (!decoded) continue;
            if (decoded.name !== "batchSettledEvent" && decoded.name !== "BatchSettledEvent") continue;
            const d = decoded.data as {
              batchId?: { toString(): string };
              batch_id?: { toString(): string };
              clearingPrice?: { toString(): string };
              clearing_price?: { toString(): string };
              filledOwners?: { equals?: (k: unknown) => boolean }[];
              filled_owners?: { equals?: (k: unknown) => boolean }[];
            };
            const batchId = d.batchId ?? d.batch_id;
            const clearingPrice = d.clearingPrice ?? d.clearing_price;
            const owners = d.filledOwners ?? d.filled_owners;
            if (!batchId || !clearingPrice) continue;
            qc.invalidateQueries({ queryKey: ["position"] });
            qc.invalidateQueries({ queryKey: ["userCollateral"] });
            qc.invalidateQueries({ queryKey: ["batchBuffer"] });
            const you =
              !!publicKey &&
              Array.isArray(owners) &&
              owners.some((o) => o?.equals?.(publicKey));
            const fill: Fill = {
              batchId: BigInt(batchId.toString()),
              clearingPrice: BigInt(clearingPrice.toString()),
              youFilled: !!you,
              ts: Date.now(),
            };
            setFills((prev) => {
              // de-dupe if the same batch settles twice via WS + replay
              if (prev[0] && prev[0].batchId === fill.batchId) return prev;
              return [fill, ...prev].slice(0, 50);
            });
          }
        },
        "confirmed",
      );
    } catch {
      return;
    }
    return () => {
      if (subId !== undefined) conn.removeOnLogsListener(subId);
    };
  }, [program, publicKey, qc]);

  return fills;
}
