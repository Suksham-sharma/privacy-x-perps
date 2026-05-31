// Browser polyfills (client-side only) for the Solana/Anchor/Arcium stack:
// the Node `Buffer` global and `process.env.ARCIUM_CLUSTER_OFFSET`.
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
