"use client";
// The /trade screen shell. Loaded via dynamic(ssr:false) so all Solana/wallet
// imports stay client-only. Phases 2–4 wire order ticket + collateral + position
// + live settle events; the chart slots into this layout in Phase 5.
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BatchChip } from "./BatchChip";
import { OrderTicket } from "./OrderTicket";
import { PositionsPanel } from "./PositionsPanel";
import { CollateralPanel } from "./CollateralPanel";
import { useBatchSettledEvent } from "@/hooks/useBatchSettledEvent";

export default function TradeScreen() {
  const fill = useBatchSettledEvent();

  return (
    <div className="trade-shell">
      <header className="trade-top">
        <div className="trade-brand">
          <span className="trade-mkt">SOL-PERP</span>
          <span className="trade-tag">Confidential · localnet</span>
          <BatchChip />
        </div>
        <WalletMultiButton />
      </header>

      {fill && (
        <div className={`fill-banner ${fill.youFilled ? "you" : ""}`}>
          {fill.youFilled ? "Filled" : "Batch settled"} @{" "}
          {fill.clearingPrice.toLocaleString("en-US")} · batch #
          {fill.batchId.toString()}
        </div>
      )}

      <main className="trade-grid">
        <OrderTicket />
        <PositionsPanel />
        <CollateralPanel />
      </main>
    </div>
  );
}
