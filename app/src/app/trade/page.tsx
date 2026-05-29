"use client";
// /trade — confidential perps terminal. The screen is loaded with ssr:false so
// all the Solana/Anchor/Arcium imports (and window-touching wallet UI) only ever
// run in the browser (the SSR-dodge from review refinement 4b).
import dynamic from "next/dynamic";

const TradeScreen = dynamic(() => import("@/components/trade/TradeScreen"), {
  ssr: false,
  loading: () => <div className="trade-loading">Loading terminal…</div>,
});

export default function TradePage() {
  return <TradeScreen />;
}
