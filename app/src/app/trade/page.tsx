"use client";
// /trade terminal — loaded ssr:false so all Solana/Anchor/Arcium + wallet UI runs browser-only.
import dynamic from "next/dynamic";

const TradeScreen = dynamic(() => import("@/components/trade/TradeScreen"), {
  ssr: false,
  loading: () => <div className="trade-loading">Loading terminal…</div>,
});

export default function TradePage() {
  return <TradeScreen />;
}
