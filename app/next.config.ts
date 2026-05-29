import type { NextConfig } from "next";
import path from "node:path";

// We run the bundler in **webpack** mode (`next dev/build --webpack`), not the
// Next 16 default Turbopack. Reason: the Solana/Arcium browser stack needs Node
// builtins stubbed, and webpack's `resolve.fallback` is the canonical,
// well-documented recipe for that (Turbopack's polyfill story is immature and
// also refuses to resolve files outside the project root, which our
// `../../../target/*` IDL import needs).
const nextConfig: NextConfig = {
  // Pin the monorepo root for build file-tracing. Without this Next picks the
  // wrong root (it found a stray ~/pnpm-lock.yaml) since the repo has multiple
  // lockfiles. cwd is the app package dir under `pnpm --filter ... dev/build`.
  outputFileTracingRoot: path.resolve(process.cwd(), ".."),

  // The SDK ships raw TypeScript (its `main` points at src/index.ts), so Next
  // must transpile it rather than treat it as a prebuilt dependency.
  transpilePackages: ["@confidential-perps/sdk"],

  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // Client bundle only. web3.js + Anchor ship browser builds (they just
      // need Buffer). @arcium-hq/client has NO browser build and statically
      // imports Node `fs` (its Node-only uploadCircuit path) and `crypto`
      // (createHash/createCipheriv used by features we never call client-side —
      // the x25519 + RescueCipher encrypt path uses @noble, not Node crypto).
      // So stub them empty. If a real runtime path ever needs them, swap the
      // `false`s for `require.resolve("crypto-browserify"/"stream-browserify")`.
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        crypto: false,
        stream: false,
      };
      // Provide the Buffer global to modules that reference it bare (bn.js,
      // arcium client), complementing the explicit `import {Buffer}` that the
      // web3.js/Anchor browser builds already do.
      config.plugins.push(
        new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"] }),
      );
    }
    return config;
  },
};

export default nextConfig;
