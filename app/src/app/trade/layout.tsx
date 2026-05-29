// Segment layout for /trade. Server component that wraps the trade subtree in
// the client <Providers> stack (wallet + Anchor + query). Keeping the providers
// here rather than in the root layout means the marketing routes never pull the
// Solana bundle (the SSR-dodge from the plan's review refinement 4b).
import { Providers } from "@/app/providers";

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Providers>{children}</Providers>;
}
