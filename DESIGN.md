# Iceberg — Design System

**Product name (locked): Iceberg.** "Confidential perps" is the category descriptor, not the
name. *Iceberg order* = the TradFi term for an order whose true size sits hidden below the
surface — only the tip shows. We go further: nothing shows pre-match (the whole berg is
submerged). **Codename: "Declassified."** Source of truth for the marketing site and the
`/trade` app. Reference mockup: [`design/landing-mockup.html`](design/landing-mockup.html).
Live build: `app/` (Next.js 16).

**Tagline (locked):** *Private trades, public proofs.* — hero kicker *Privacy × Perps · Solana Devnet*.

---

## 1. Concept

A confidential financial **dossier**, rendered in light / paper. The product — orders
encrypted client-side, matched inside an MPC network, settled on-chain — is made literal:
encrypted values appear as **redaction bars** and monospace ciphertext. Your own data reads
in plaintext; everyone else's stays sealed. The aesthetic is editorial, precise, and
document-grade — closer to a banknote or a classified file than a typical DeFi app.

## 2. Hard rules (anti-slop)

These are non-negotiable. Earlier attempts were rejected for breaking them.

- **No emoji as icons.** Use the inline line-icon set (key, lock, arrow, check) or nothing.
- **No cyan-on-black, no radial-glow dark heroes, no purple-on-white.** Those read as AI-generated.
- **No repeated template.** Do not stamp out "tiny eyebrow → big title with one accent word →
  row of three identical cards" on every section. Vary the layout per section.
- **No fake interactive crypto demos.** Redaction is static. Your own rows render in plaintext;
  others stay redacted. Never ship a "click to decrypt" gimmick.
- **Cards must have structure** — an ink border, a header strip, and a hard offset shadow.
  No faint floaty boxes.

## 3. Color (light)

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#F2EEE4` | Page background (warm bone) |
| `--paper-2` | `#EBE6D9` | Alt section band |
| `--card` | `#FBFAF5` | Card / panel surface |
| `--ink` | `#1A1815` | Primary text, borders, dark bars |
| `--ink-2` | `#45413A` | Secondary text |
| `--muted` | `#736D5F` | Labels, captions |
| `--line` | `rgba(26,24,21,0.14)` | Hairline rules |
| `--line-2` | `rgba(26,24,21,0.28)` | Stronger rules |
| `--accent` | `#2438DE` | Ink-blue: CTAs, links, focus, seal/stamps |
| `--accent-deep` | `#1A2AAE` | Accent hover |
| `--long` | `#1C7C4A` | Long / positive PnL (financial green) |
| `--short` | `#B83227` | Short / negative PnL / "Confidential" (brick red) |

Accent and green/red are **used sparingly**: accent for action + key marks, green/red for
direction + PnL only. Everything else is ink on paper.

## 4. Typography

Loaded via Google Fonts (mockup) / `next/font/google` (app).

- **Display — Fraunces** (serif, optical). Headlines, section titles, big statements.
  Weight 500, tight tracking (`-0.02em` to `-0.03em`). Italic for the emphasized word.
- **UI — Archivo** (grotesque). Body copy, nav, buttons, captions.
- **Data — IBM Plex Mono.** Every number, address, ciphertext, label, and stamp.
  `font-variant-numeric: tabular-nums`. Uppercase + letter-spacing for labels.

Scale (clamp): hero `46–92px` · section title `30–52px` · sub `16–18px` · body `14–16px` ·
mono labels `9–11px` uppercase, `0.12–0.18em` tracking.

## 5. Spacing · radius · shadow · motion

- **Spacing:** 4px base. Section padding `96–108px`. Container max-width `1160px`, `32px` gutters.
- **Radius:** sharp. `2–4px` on most elements; the document feel relies on corners, not pills.
  Buttons are rectangular (not rounded pills).
- **Shadow:** hard offset, no glow. Cards use `8–12px 8–12px 0 rgba(26,24,21,0.07)`.
- **Motion:** restrained. Sticky-nav shadow on scroll, FAQ accordion, a slow marquee on the
  classification strip, a blinking cursor in terminal contexts. No scattered micro-animations.

## 6. Components

- **Buttons.** Rectangular, mono uppercase label, `1.5px` ink border. Primary = solid `--accent`
  (white text). Secondary = transparent, ink border, inverts on hover. Sizes sm/md/lg.
- **Dossier / cards.** `--card` surface, `1.5px` ink border, dark header strip (ink bg, paper text)
  with a mono title + index, hard offset shadow. Dashed inner row dividers.
- **Terminal (light "report").** Ink top bar (market, stats, "Encrypted session"), ink-line chart
  on paper with a faint accent fill + hairline gridlines, orderbook with **redaction bars** for
  size, order ticket (Long/Short, leverage, "Encrypt & Submit").
- **Ledger / tables.** Ink header row (paper text), hairline body rows, the "us"/"you" column
  tinted with `rgba(36,56,222,0.045)` + a `3px` inset accent rule. Mono throughout.
- **FAQ.** Numbered (`Q1…`) Fraunces questions, hairline dividers, `+` that rotates to `×`.
- **Stamps.** Rotated (~`-4deg`), `2px` outlined, mono uppercase. Red = "Confidential", blue =
  "MPC-Sealed", green = "Cleared".
- **Classification strip.** Full-width ink bar, slow marquee of mono uppercase microcopy.
- **Microprint.** Tiny (`8px`) repeated mono text as a security-print divider.
- **Seal.** A single guilloché medallion cropped to a circle with a double ring — certificate seal.

## 7. Signature motifs

1. **Redaction = encrypted.** Ink bars (`██`) and monospace ciphertext (`0x9a4f…3c21`) stand in
   for sealed values. This is the core identity element.
2. **Your row is legible; others are sealed.** In any position list, the user's own row renders
   in plaintext (accent-tinted); other traders' rows stay redacted. Honest, not gimmicky.
3. **Seal + classification + microprint** — the "official document" furniture that ties it together.
4. **Guilloché watermark + seal.** The security-print artwork appears faint (~19%, `multiply`)
   in the hero's top-right as atmosphere, and cropped to a circular medallion (double ring) as the
   **footer seal**. Never behind body text. (The hero's quick-facts row was removed — keep the
   hero to headline + dossier.)

## 8. Assets

- `app/public/guilloche.webp` — guilloché security pattern (hero watermark + seal fill).
  Optimized from the Gemini source (`design/ref-guilloche-gemini.png`, ~11.7MB) → **118KB**
  WebP via `cwebp -q 42 -resize 800 0`. Used at `multiply` blend so the white ground drops out
  on paper; low opacity, so the resolution drop is invisible. Regenerate from the source if a
  higher-fidelity crop is ever needed.
- The footer / certificate seal is a **component** (`IcebergSeal`), not a baked PNG — a circular
  guilloché crop + double ring + the berg centered.

## 9. Tailwind mapping (`theme.extend`)

```js
colors: {
  paper: { DEFAULT: '#F2EEE4', 2: '#EBE6D9' },
  card: '#FBFAF5',
  ink: { DEFAULT: '#1A1815', 2: '#45413A' },
  muted: '#736D5F',
  accent: { DEFAULT: '#2438DE', deep: '#1A2AAE' },
  long: '#1C7C4A',
  short: '#B83227',
},
fontFamily: {
  serif: ['var(--font-fraunces)', 'Georgia', 'serif'],
  sans:  ['var(--font-archivo)', 'system-ui', 'sans-serif'],
  mono:  ['var(--font-plex-mono)', 'ui-monospace', 'monospace'],
},
borderColor: { line: 'rgba(26,24,21,0.14)', 'line-2': 'rgba(26,24,21,0.28)' },
boxShadow: { doc: '10px 10px 0 rgba(26,24,21,0.07)' },
```

Fonts via `next/font/google` exposing `--font-fraunces`, `--font-archivo`, `--font-plex-mono`.

### Build reality (as implemented)

The app is **Next.js 16 + Tailwind v4**, so tokens live in `app/src/app/globals.css` under
`@theme inline` (no `tailwind.config`). The snippet above is the conceptual token map. The
component architecture follows Tailwind v4 idiom:

- **Tokens** → `@theme` (gives `bg-paper`, `text-ink`, `font-serif`, …).
- **Hero** → Tailwind utility classes in the JSX.
- **Bespoke components** (terminal, ledger, stamps, redaction, marquee, table) → `@layer components`.
- Fonts via `next/font/google`.

**Hero (locked):** centered manifesto — a `Privacy × Perps · Solana Devnet` kicker (flanking
hairlines) over a centered Fraunces headline *Private trades, public proofs.* (`public`
accent-italic, `proofs.` ink-outlined); subhead + CTAs in the default left/right split beneath;
guilloché as a centered watermark band. The standalone Privacy-ledger section was cut from the
page (the redaction motif still lives in the hero treatment + the terminal orderbook).

## 10. Brand mark & icon

The mark is a **faceted iceberg**: a wireframe tip above the waterline (the visible "plaintext"
slice) over a solid mass below (the sealed/redacted bulk). Tiny tip, large submerged mass — the
proportion *is* the thesis. Origin: a Gemini-generated vector master (`design/ref-iceberg-gemini.svg`),
cropped to the berg bbox (viewBox `333 91 380 380`) and recolored to `currentColor` so it themes
to ink / paper / accent for free.

- **`IcebergMark`** (`app/src/components/IcebergMark.tsx`) — the full faceted berg, inline SVG,
  `fill="currentColor"`, `size` prop. Used in the nav + footer brand and inside the seal. Path
  data is generated from the source SVG — regenerate, don't hand-edit.
- **`IcebergSeal`** (`app/src/components/IcebergSeal.tsx`) — circular medallion: guilloché crop
  (`multiply`) + double ring + centered berg; `accent` variant swaps the ring to ink-blue.
- **Favicon** (`app/src/app/icon.svg`, Next file convention) — a **simplified-tip** berg (solid
  mass + a single solid triangle tip, no fine facets) so it stays crisp at 16px where the
  wireframe slivers would mush. Includes a `prefers-color-scheme: dark` fill swap.
- **Wordmark** — *Iceberg* in **Fraunces, italic, title case**, with *berg* in `--accent`.
  Renders `Ice<em>berg</em>` via `.brand .name` (whole name italic; `em` = accent). Echoes the
  hero headline's italic-accent treatment rather than the colder mono caps it replaced.
