"use client";
// useProgram() — builds an Anchor Program bound to the connected wallet. Program
// ID comes from idl.address, so it stays in sync with the deployed program.
import { useMemo } from "react";
import { AnchorProvider, Program } from "@anchor-lang/core";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import idl from "../../../target/idl/confidential_perps.json";
import type { ConfidentialPerps } from "../../../target/types/confidential_perps";

export function useProgram(): Program<ConfidentialPerps> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    return new Program(idl as ConfidentialPerps, provider);
  }, [connection, wallet]);
}
