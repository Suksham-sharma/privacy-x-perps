"use client";
// Candlestick chart for the terminal, rendered with lightweight-charts.
//
// Data is REAL SOL/USD spot (Binance klines) — a market reference, not faked.
// The protocol's on-chain mark on localnet is a fixed Pyth fixture (100,000
// ticks), so the chart's USD scale and the on-chain index live in different
// units for now; the in-chart note states this, and entry/liq overlays are
// intentionally omitted until the live-price localnet fixture aligns the units
// (the `entry`/`liq` props + createPriceLine path below are ready for that).
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type UTCTimestamp,
} from "lightweight-charts";

type TF = "15m" | "1H" | "4H" | "1D";
const TF_TO_BINANCE: Record<TF, string> = { "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
const TFS: TF[] = ["15m", "1H", "4H", "1D"];

export interface Quote {
  last: number;
  chgAbs: number;
  chgPct: number;
}

type Source = "loading" | "binance" | "sample" | "error";

// Deterministic believable fallback so the chart never looks broken offline.
function sampleCandles(count = 200, stepSec = 14400): CandlestickData<UTCTimestamp>[] {
  const out: CandlestickData<UTCTimestamp>[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - count * stepSec;
  let prev = 131;
  for (let i = 0; i < count; i++) {
    const close = 131 + Math.sin(i / 5) * 2.3 + i * 0.05 + Math.sin(i * 1.7) * 1.05;
    const open = prev;
    const high = Math.max(open, close) + 0.4 + Math.abs(Math.sin(i * 2.3)) * 0.8;
    const low = Math.min(open, close) - 0.4 - Math.abs(Math.cos(i * 1.9)) * 0.8;
    out.push({ time: (start + i * stepSec) as UTCTimestamp, open, high, low, close });
    prev = close;
  }
  return out;
}

async function fetchCandles(tf: TF): Promise<CandlestickData<UTCTimestamp>[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=${TF_TO_BINANCE[tf]}&limit=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const raw: unknown[][] = await res.json();
  return raw.map((k) => ({
    time: Math.floor(Number(k[0]) / 1000) as UTCTimestamp,
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));
}

export function PriceChart({
  onQuote,
  entry,
  liq,
}: {
  onQuote?: (q: Quote) => void;
  entry?: number;
  liq?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const quoteCb = useRef(onQuote);
  quoteCb.current = onQuote;

  const [tf, setTf] = useState<TF>("15m");
  const [source, setSource] = useState<Source>("loading");
  const [quote, setQuote] = useState<Quote | null>(null);

  // create chart once
  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#FBFAF5" },
        textColor: "#736D5F",
        fontFamily: "IBM Plex Mono, ui-monospace, monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(26,24,21,0.045)" },
        horzLines: { color: "rgba(26,24,21,0.06)" },
      },
      leftPriceScale: { visible: true, borderColor: "rgba(26,24,21,0.18)" },
      rightPriceScale: { visible: false },
      timeScale: { borderColor: "rgba(26,24,21,0.18)", timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(26,24,21,0.45)", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#1A1815" },
        horzLine: { color: "rgba(26,24,21,0.45)", style: LineStyle.Dashed, labelBackgroundColor: "#1A1815" },
      },
    });
    const series = chart.addSeries(CandlestickSeries, {
      priceScaleId: "left",
      upColor: "#1C7C4A", // filled green = up
      downColor: "#B83227", // filled brick-red = down
      borderUpColor: "#1C7C4A",
      borderDownColor: "#B83227",
      wickUpColor: "#1C7C4A",
      wickDownColor: "#B83227",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // load + refresh data on timeframe change (and poll for liveness)
  useEffect(() => {
    let cancelled = false;
    setSource("loading");

    async function load() {
      let data: CandlestickData<UTCTimestamp>[];
      let src: Source;
      try {
        data = await fetchCandles(tf);
        src = "binance";
      } catch {
        data = sampleCandles();
        src = "sample";
      }
      if (cancelled || !seriesRef.current) return;
      seriesRef.current.setData(data);
      chartRef.current?.timeScale().fitContent();
      setSource(src);
      if (data.length) {
        const last = data[data.length - 1].close;
        const first = data[0].close;
        const q: Quote = { last, chgAbs: last - first, chgPct: ((last - first) / first) * 100 };
        setQuote(q);
        quoteCb.current?.(q);
      }
    }

    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tf]);

  // entry / liq overlays — wired for when units align (see header note)
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const lines: IPriceLine[] = [];
    if (entry !== undefined) {
      lines.push(
        series.createPriceLine({ price: entry, color: "#2438DE", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "ENTRY" }),
      );
    }
    if (liq !== undefined) {
      lines.push(
        series.createPriceLine({ price: liq, color: "#B83227", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "LIQ" }),
      );
    }
    return () => lines.forEach((l) => series.removePriceLine(l));
  }, [entry, liq, source]);

  const up = (quote?.chgPct ?? 0) >= 0;

  return (
    <>
      <div className="tchart-bar">
        <span className="px">{quote ? quote.last.toFixed(2) : "—"}</span>
        <span className={`chg ${up ? "up" : "down"}`}>
          {quote ? `${up ? "+" : ""}${quote.chgAbs.toFixed(2)} (${quote.chgPct.toFixed(2)}%)` : "—"}
        </span>
        <span className="pair">SOL / USD · spot</span>
        <div className="tchart-tf">
          {TFS.map((t) => (
            <button key={t} className={t === tf ? "on" : ""} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="tchart-canvas">
        <div ref={wrapRef} style={{ position: "absolute", inset: 0 }} />
        <span className="tchart-note">
          {source === "loading"
            ? "Loading price…"
            : source === "sample"
              ? "Sample data · live feed unavailable"
              : "SOL/USD spot · on-chain index = localnet fixture"}
        </span>
      </div>
    </>
  );
}
