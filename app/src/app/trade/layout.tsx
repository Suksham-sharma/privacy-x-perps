// /trade segment layout: wraps the subtree in <Providers> here (not root) so
// marketing routes never pull the Solana bundle.
import { Providers } from "@/app/providers";

export default function TradeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Providers>{children}</Providers>;
}
