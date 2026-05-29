// Browser polyfills for the Solana/Anchor/Arcium stack. web3.js v1 + Anchor
// reference the Node `Buffer` global at runtime; the Arcium client reads
// `process.env.ARCIUM_CLUSTER_OFFSET`. We install both client-side only — on
// the server (SSR) these globals exist natively. Imported once, first thing in
// the provider tree.
import { Buffer } from "buffer";
import { ARCIUM_CLUSTER_OFFSET } from "./config";

if (typeof window !== "undefined") {
  const g = globalThis as unknown as {
    Buffer?: typeof Buffer;
    process?: { env?: Record<string, string | undefined> };
  };
  if (!g.Buffer) g.Buffer = Buffer;
  if (!g.process) g.process = { env: {} };
  if (!g.process.env) g.process.env = {};
  g.process.env.ARCIUM_CLUSTER_OFFSET ??= String(ARCIUM_CLUSTER_OFFSET);
}

export {};
