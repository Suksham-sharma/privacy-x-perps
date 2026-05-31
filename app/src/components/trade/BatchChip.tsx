"use client";
// Live batch-auction status: which batch is filling, how many orders are queued
// (n/4), and whether the keeper is mid-match. Reads the BatchBuffer PDA.
import { useBatchBuffer } from "@/hooks/useBatchBuffer";

export function BatchChip() {
  const { data, isLoading } = useBatchBuffer();

  if (isLoading || !data) {
    return (
      <span className="bchip">
        <span className="bpip idle" />
        BATCH —
      </span>
    );
  }

  const matching = data.isProcessing;
  return (
    <span className={`bchip ${matching ? "matching" : ""}`}>
      <span className={`bpip ${matching ? "live" : "idle"}`} />
      BATCH #{data.batchId.toString()} · {data.nOrders}/4 ·{" "}
      {matching ? "matching…" : "sealed"}
    </span>
  );
}
