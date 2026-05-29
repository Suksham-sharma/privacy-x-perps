import { SiteNav } from "@/components/SiteNav";
import { Faq } from "@/components/Faq";
import { IcebergMark } from "@/components/IcebergMark";
import { IcebergSeal } from "@/components/IcebergSeal";

function Strip() {
  return (
    <span>
      <span className="dot">◆</span> NOW TRADING · SOL-PERP <span className="dot">◆</span>{" "}
      ENCRYPTED CLIENT-SIDE <span className="dot">◆</span> MATCHED IN ARCIUM MPC{" "}
      <span className="dot">◆</span> SETTLED ON SOLANA <span className="dot">◆</span>{" "}
      PRIVATE TRADES · PUBLIC PROOFS{" "}
    </span>
  );
}

const MICRO = "iceberg · confidential perps · ".repeat(40);

export default function Home() {
  return (
    <>
      {/* icon sprite */}
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <defs>
          <symbol id="i-key" viewBox="0 0 24 24">
            <circle cx="8" cy="8" r="5" />
            <path d="M11.5 11.5 L20 20 M17 17 l3 0 M16 16 l0 3" />
          </symbol>
          <symbol id="i-lock" viewBox="0 0 24 24">
            <rect x="5" y="11" width="14" height="9" rx="1" />
            <path d="M8 11 V7 a4 4 0 0 1 8 0 v4" />
          </symbol>
          <symbol id="i-arrow" viewBox="0 0 24 24">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </symbol>
          <symbol id="i-check" viewBox="0 0 24 24">
            <path d="M5 13l4 4L19 7" />
          </symbol>
        </defs>
      </svg>

      <div className="classbar">
        <div className="scroll">
          <Strip />
          <Strip />
        </div>
      </div>

      <SiteNav />

      {/* HERO — centered manifesto */}
      <section className="relative flex min-h-[88vh] flex-col overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 bg-[url(/guilloche.webp)] bg-cover bg-center bg-no-repeat opacity-[0.15] mix-blend-multiply [mask-image:radial-gradient(72%_80%_at_50%_46%,#000_16%,transparent_82%)]"
        />
        <div className="relative z-[1] mx-auto flex w-full max-w-[1160px] flex-1 flex-col px-8 pt-16 pb-16">
          {/* centered: kicker + headline */}
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <span className="flex items-center gap-4">
              <span className="h-px w-14 bg-line-2" />
              <span className="font-mono text-[12px] font-medium uppercase tracking-[0.24em] text-ink-2 whitespace-nowrap">
                Privacy <span className="text-accent">×</span> Perps · Solana Devnet
              </span>
              <span className="h-px w-14 bg-line-2" />
            </span>
            <h1 className="mt-7 font-serif font-semibold leading-[0.92] tracking-[-0.035em] text-[clamp(48px,7.6vw,104px)]">
              Private trades,
              <span className="block">
                <em className="italic text-accent">public</em>{" "}
                <span className="text-transparent [-webkit-text-stroke:2px_#1a1815]">
                  proofs.
                </span>
              </span>
            </h1>
          </div>
          {/* default alignment: subhead + CTAs */}
          <div className="flex items-end justify-between gap-12 pt-12 max-[880px]:flex-col max-[880px]:items-start max-[880px]:gap-8">
            <p className="max-w-[42ch] text-[17px] leading-[1.6] text-ink-2">
              Orders encrypted in your browser, matched inside{" "}
              <b className="font-semibold text-ink">Arcium&apos;s MPC</b> network,
              settled on-chain. Your size is sealed —{" "}
              <b className="font-semibold text-ink">even from us</b>.
            </p>
            <div className="flex shrink-0 flex-wrap gap-4">
              <a href="/trade" className="btn btn-accent btn-lg">
                Launch Terminal{" "}
                <svg className="ic arrow">
                  <use href="#i-arrow" />
                </svg>
              </a>
              <a href="#how" className="btn btn-lg">
                How it works
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <div className="microprint">{MICRO}</div>
      </div>

      {/* TERMINAL */}
      <section className="block" id="terminal" style={{ paddingTop: "56px" }}>
        <div className="wrap">
          <div className="sec-head">
            <div className="left">
              <span className="sec-num">01 — The Terminal</span>
              <h2 className="sec-title">
                A trading desk that <em>keeps your secrets.</em>
              </h2>
            </div>
            <div className="right">
              Full depth, real fills, on-chain settlement. The only thing missing
              is everyone else&apos;s view of your size.
            </div>
          </div>

          <div className="term">
            <div className="term-bar">
              <span className="mkt">
                <span className="glyph" /> SOL-PERP
              </span>
              <div className="term-stats">
                <div className="s">
                  <span className="k">Mark</span>
                  <span className="v">142.0830</span>
                </div>
                <div className="s">
                  <span className="k">24h</span>
                  <span className="v up">+3.42%</span>
                </div>
                <div className="s">
                  <span className="k">Funding</span>
                  <span className="v">0.0094%</span>
                </div>
                <div className="s">
                  <span className="k">Open Int.</span>
                  <span className="v">$12.4M</span>
                </div>
              </div>
              <div className="term-spacer" />
              <span className="sess">
                <span className="pip" /> Encrypted session
              </span>
            </div>
            <div className="term-body">
              <div className="term-chart">
                <div className="chart-head">
                  <span className="px">142.0830</span>
                  <span className="chg">+4.71 (3.42%)</span>
                  <div className="tf">
                    <span>15m</span>
                    <span>1H</span>
                    <span className="on">4H</span>
                    <span>1D</span>
                  </div>
                </div>
                <div className="chart-svg">
                  <svg viewBox="0 0 620 172" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="cf" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="rgba(36,56,222,0.12)" />
                        <stop offset="1" stopColor="rgba(36,56,222,0)" />
                      </linearGradient>
                    </defs>
                    <line x1="0" y1="43" x2="620" y2="43" stroke="rgba(26,24,21,0.07)" />
                    <line x1="0" y1="86" x2="620" y2="86" stroke="rgba(26,24,21,0.07)" />
                    <line x1="0" y1="129" x2="620" y2="129" stroke="rgba(26,24,21,0.07)" />
                    <path
                      d="M0,128 C50,120 80,138 110,112 C150,80 175,100 210,82 C250,62 280,92 315,74 C350,58 380,30 415,46 C450,62 480,28 515,30 C555,32 585,16 620,14 L620,172 L0,172 Z"
                      fill="url(#cf)"
                    />
                    <path
                      d="M0,128 C50,120 80,138 110,112 C150,80 175,100 210,82 C250,62 280,92 315,74 C350,58 380,30 415,46 C450,62 480,28 515,30 C555,32 585,16 620,14"
                      fill="none"
                      stroke="var(--ink)"
                      strokeWidth="1.6"
                    />
                    <circle cx="620" cy="14" r="3" fill="var(--accent)" />
                  </svg>
                </div>
                <div className="ob">
                  <div className="ob-h">
                    <span>Price · USDC</span>
                    <span>Size</span>
                    <span>Trader</span>
                  </div>
                  <div className="ob-row ask">
                    <span className="p">142.40</span>
                    <span className="sz">
                      <span className="redact">██████</span>
                    </span>
                    <span className="tr">0x7f…a2</span>
                  </div>
                  <div className="ob-row ask">
                    <span className="p">142.22</span>
                    <span className="sz">
                      <span className="redact">████</span>
                    </span>
                    <span className="tr">0x3c…9e</span>
                  </div>
                  <div className="ob-row bid">
                    <span className="p">142.05</span>
                    <span className="sz">
                      <span className="redact">███████</span>
                    </span>
                    <span className="tr">0x9a…41</span>
                  </div>
                  <div className="ob-row bid">
                    <span className="p">141.88</span>
                    <span className="sz">
                      <span className="redact">█████</span>
                    </span>
                    <span className="tr">0xb1…7d</span>
                  </div>
                </div>
              </div>
              <div className="ticket">
                <div className="ls">
                  <button className="on-long">Long</button>
                  <button>Short</button>
                </div>
                <div className="fld">
                  <div className="flab">
                    <span>Size</span>
                    <span>Bal 4,820.00</span>
                  </div>
                  <div className="fin">
                    <span className="redact">███████</span>
                    <span className="u">USDC</span>
                  </div>
                </div>
                <div className="fld">
                  <div className="flab">
                    <span>Leverage</span>
                    <span style={{ color: "var(--accent)" }}>4.0×</span>
                  </div>
                  <div className="lev-track">
                    <div className="lev-fill" />
                    <div className="lev-knob" />
                  </div>
                  <div className="lev-marks">
                    <span>1×</span>
                    <span>5×</span>
                    <span>10×</span>
                  </div>
                </div>
                <div className="ticket-sum">
                  <div className="l">
                    <span className="k">Entry</span>
                    <span>142.08</span>
                  </div>
                  <div className="l">
                    <span className="k">Liq. price</span>
                    <span className="redact">█████</span>
                  </div>
                  <div className="l">
                    <span className="k">Fee</span>
                    <span>0.04%</span>
                  </div>
                </div>
                <div className="seal">
                  <svg className="ic">
                    <use href="#i-lock" />
                  </svg>{" "}
                  Encrypted before it leaves your browser
                </div>
                <button className="submit">Encrypt &amp; Submit</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* LIFECYCLE */}
      <section className="block" id="how">
        <div className="wrap">
          <div className="sec-head">
            <div className="left">
              <span className="sec-num">02 — Lifecycle</span>
              <h2 className="sec-title">
                Three steps. <em>Zero leakage.</em>
              </h2>
            </div>
            <div className="right">
              Every action maps to a cryptographic guarantee — from your keyboard
              to the chain.
            </div>
          </div>
          <div className="seq">
            <div className="seq-step">
              <div className="seq-num">I</div>
              <h3>Encrypt</h3>
              <p>
                You set size and leverage. The client encrypts them against the
                network&apos;s threshold key before you sign.
              </p>
              <div className="seq-demo">
                <span style={{ color: "var(--muted)" }}>184.50</span>
                <span className="ar">→</span>
                <span style={{ color: "var(--accent)" }}>enc()</span>
                <span className="ar">→</span>
                <span className="redact">0x9a4f…3c21</span>
              </div>
            </div>
            <div className="seq-step">
              <div className="seq-num">II</div>
              <h3>Match in MPC</h3>
              <p>
                Arcium&apos;s compute network runs the matching circuit directly
                over ciphertext. No node decrypts. No node learns your size.
              </p>
              <div className="seq-demo">
                <span className="redact">████</span>
                <span className="ar">×</span>
                <span className="redact">████</span>
                <span className="ar">→</span>
                <span style={{ color: "var(--long)" }}>matched ✓</span>
              </div>
            </div>
            <div className="seq-step">
              <div className="seq-num">III</div>
              <h3>Settle on-chain</h3>
              <p>
                The fill posts to Solana with a proof. Collateral and PnL update;
                your size stays sealed in state.
              </p>
              <div className="seq-demo">
                <span style={{ color: "var(--muted)" }}>tx</span>
                <span style={{ color: "var(--accent)" }}>5Jq…f2A</span>
                <span style={{ color: "var(--long)" }}>confirmed</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap">
        <div className="microprint">{MICRO}</div>
      </div>

      {/* COMPARE */}
      <section className="block" id="compare">
        <div className="wrap">
          <div className="sec-head">
            <div className="left">
              <span className="sec-num">03 — The Difference</span>
              <h2 className="sec-title">
                Built for traders who <em>move size.</em>
              </h2>
            </div>
            <div className="right">
              Same on-chain settlement you expect. None of the exposure
              you&apos;ve learned to live with.
            </div>
          </div>
          <div className="cmp">
            <table>
              <thead>
                <tr>
                  <th style={{ width: "46%" }}>Capability</th>
                  <th>Typical Perp DEX</th>
                  <th className="us">Iceberg</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="feat">Position size visible to market</td>
                  <td className="them">
                    <span className="x">●</span> Fully public
                  </td>
                  <td className="us">
                    <span className="ok">✓</span> Encrypted
                  </td>
                </tr>
                <tr>
                  <td className="feat">Copy-trading / front-running your book</td>
                  <td className="them">
                    <span className="x">✕</span> Exposed
                  </td>
                  <td className="us">
                    <span className="ok">✓</span> Prevented
                  </td>
                </tr>
                <tr>
                  <td className="feat">Liquidation hunting on large positions</td>
                  <td className="them">
                    <span className="x">✕</span> Targeted
                  </td>
                  <td className="us">
                    <span className="ok">✓</span> Size hidden
                  </td>
                </tr>
                <tr>
                  <td className="feat">On-chain settlement &amp; verifiability</td>
                  <td className="them">
                    <span className="ok">✓</span> Yes
                  </td>
                  <td className="us">
                    <span className="ok">✓</span> Yes
                  </td>
                </tr>
                <tr>
                  <td className="feat">Operator can read your positions</td>
                  <td className="them">
                    <span className="x">●</span> Sees everything
                  </td>
                  <td className="us">
                    <span className="ok">✓</span> Nobody, incl. us
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="block" id="faq" style={{ paddingTop: "40px" }}>
        <div className="wrap">
          <div className="sec-head">
            <div className="left">
              <span className="sec-num">04 — Record</span>
              <h2 className="sec-title">
                Questions, <em>answered.</em>
              </h2>
            </div>
          </div>
          <Faq />
        </div>
      </section>

      {/* CTA */}
      <section className="cta-cert">
        <div className="wrap">
          <div className="cert">
            <div className="cert-in">
              <span className="corner tl" />
              <span className="corner tr" />
              <span className="corner bl" />
              <span className="corner br" />
              <div className="kicker">Iceberg · Bearer Access</div>
              <div className="orn">✦ ✦ ✦</div>
              <h2>
                Trade in the dark.
                <br />
                Settle in <em>the open.</em>
              </h2>
              <p>
                Place encrypted orders, keep your size sealed, and settle on-chain
                with proofs anyone can verify.
              </p>
              <div className="btns">
                <a href="/trade" className="btn btn-accent btn-lg">
                  Launch Terminal{" "}
                  <svg className="ic arrow">
                    <use href="#i-arrow" />
                  </svg>
                </a>
                <a href="#how" className="btn btn-lg">
                  How it works
                </a>
              </div>
              <div className="seal-row">
                <span>No. A47-2F</span>
                <span className="stamp blue" style={{ transform: "rotate(-3deg)" }}>
                  MPC-Sealed
                </span>
                <span>Devnet 2026</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer>
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <a href="#" className="brand">
                <IcebergMark size={28} className="mark" />
                <span className="name">
                  Ice<em>berg</em>
                </span>
              </a>
              <p>
                The first confidential perpetuals exchange on Solana. Orders are
                matched inside Arcium&apos;s MPC network — your size stays sealed,
                settlement stays public.
              </p>
              <div className="foot-seal-wrap">
                <IcebergSeal size={104} />
                <span className="foot-seal-cap">Issued · Solana Devnet · MMXXVI</span>
              </div>
            </div>
            <div className="foot-col">
              <h4>Explore</h4>
              <a href="/trade">Launch Terminal</a>
              <a href="#how">Lifecycle</a>
              <a href="#compare">Compare</a>
              <a href="#faq">FAQ</a>
            </div>
            <div className="foot-col">
              <h4>Built with</h4>
              <a href="https://solana.com" target="_blank" rel="noreferrer">
                Solana
              </a>
              <a href="https://www.arcium.com" target="_blank" rel="noreferrer">
                Arcium MPC
              </a>
            </div>
          </div>
          <div className="foot-bottom">
            <span>© 2026 Iceberg — Solana Devnet</span>
            <span>Solana × Arcium MPC · Encrypted client-side · Settled on-chain</span>
          </div>
        </div>
      </footer>
    </>
  );
}
