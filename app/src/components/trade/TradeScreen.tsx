"use client";
// The /trade screen: a full-page confidential terminal.
//   ┌ term bar — market · live SOL mark · avail margin · deposit · wallet ┐
//   │ chart (SOL/USD candles)            │ order ticket (sealed entry)    │
//   ├ activity — Positions · Open Orders · History ──────────────────────┤
// Collateral is on-demand (deposit drawer). All Solana/Arcium imports stay
// client-only — the page mounts this via dynamic(ssr:false).
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { IcebergMark } from "@/components/IcebergMark";
import { WalletButton } from "./WalletButton";
import { PriceChart } from "./PriceChart";
import { OrderTicket } from "./OrderTicket";
import { PositionsPanel } from "./PositionsPanel";
import { OpenOrders } from "./OpenOrders";
import { DepositDrawer } from "./DepositDrawer";
import { BatchChip } from "./BatchChip";
import { useFillHistory, type Fill } from "@/hooks/useFillHistory";
import { useUserCollateral } from "@/hooks/useUserCollateral";
import { usePosition } from "@/hooks/usePosition";
import { useBatchBuffer } from "@/hooks/useBatchBuffer";
import { fmtUsdc } from "@/lib/format";

type Tab = "positions" | "orders" | "history";

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function HistoryPane({ fills }: { fills: Fill[] }) {
  if (fills.length === 0) {
    return (
      <>
        <div className="pane-empty">No settled batches yet this session.</div>
        <div className="pane-note">
          <span className="microprint">
            SETTLEMENT LOG · SESSION-SCOPED — PERSISTENT HISTORY NEEDS AN INDEXER OVER BatchSettledEvent
          </span>
        </div>
      </>
    );
  }
  return (
    <>
      {fills.map((f, i) => (
        <div className="hist-row" key={`${f.batchId}-${i}`}>
          <span className="ev">
            <span className={`tag ${f.youFilled ? "you" : "cleared"}`}>
              {f.youFilled ? "Filled" : "Settled"}
            </span>
            Batch #{f.batchId.toString()}
          </span>
          <span className="desc">Cleared @ {f.clearingPrice.toLocaleString("en-US")}</span>
          <span className="desc">{f.youFilled ? "your order matched" : "—"}</span>
          <span className="when">{ago(f.ts)}</span>
        </div>
      ))}
      <div className="pane-note">
        <span className="microprint">
          SESSION-SCOPED LOG — PERSISTENT HISTORY NEEDS AN INDEXER OVER BatchSettledEvent
        </span>
      </div>
    </>
  );
}

export default function TradeScreen() {
  const { publicKey } = useWallet();
  const fills = useFillHistory();
  const collateral = useUserCollateral();
  const position = usePosition();
  const batch = useBatchBuffer();

  const [tab, setTab] = useState<Tab>("positions");
  const [drawer, setDrawer] = useState(false);

  const me = publicKey?.toBase58();
  const posCount = position.data ? 1 : 0;
  const orderCount = me && batch.data ? batch.data.owners.filter((o) => o === me).length : 0;

  return (
    <div className="tscreen">
      <div className="classbar">
        <div className="scroll">
          {[0, 1].map((k) => (
            <span key={k}>
              <span className="dot">◆</span> NOW TRADING · SOL-PERP <span className="dot">◆</span>{" "}
              ENCRYPTED CLIENT-SIDE <span className="dot">◆</span> MATCHED IN ARCIUM MPC{" "}
              <span className="dot">◆</span> SETTLED ON SOLANA{" "}
            </span>
          ))}
        </div>
      </div>

      <header className="tbar">
        <span className="tbar-brand">
          <IcebergMark size={19} className="tbar-logo" title="Iceberg" />
          Iceberg
        </span>
        <span className="tbar-div" />
        <span className="tbar-mkt">SOL-PERP</span>

        <div className="tbar-spacer" />

        <BatchChip />
        <div className="tbar-margin">
          <span className="k">Avail. margin</span>
          <span className="v">{fmtUsdc(collateral.data)} USDC</span>
        </div>
        <button className="tbar-btn" onClick={() => setDrawer(true)}>
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Deposit
        </button>
        <div className="tbar-div" />
        <span className="tbar-sess">
          <span className="pip" /> Encrypted session
        </span>
        <WalletButton />
      </header>

      <div className="tmain">
        <section className="tchart-cell">
          <PriceChart />
        </section>
        <section className="tticket-cell">
          <div className="tticket-h">
            <span className="t">Order Ticket</span>
            <span className="n">Sealed · Market</span>
          </div>
          <OrderTicket />
        </section>
      </div>

      <section className="tact">
        <div className="tabs">
          <button className={`tab ${tab === "positions" ? "on" : ""}`} onClick={() => setTab("positions")}>
            Positions {posCount > 0 && <span className="badge">{posCount}</span>}
          </button>
          <button className={`tab ${tab === "orders" ? "on" : ""}`} onClick={() => setTab("orders")}>
            Open Orders {orderCount > 0 && <span className="badge">{orderCount}</span>}
          </button>
          <button className={`tab ${tab === "history" ? "on" : ""}`} onClick={() => setTab("history")}>
            History {fills.length > 0 && <span className="badge">{fills.length}</span>}
          </button>
        </div>
        <div className="tpane">
          {tab === "positions" && <PositionsPanel />}
          {tab === "orders" && <OpenOrders />}
          {tab === "history" && <HistoryPane fills={fills} />}
        </div>
      </section>

      <DepositDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
