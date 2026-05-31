"use client";
// Auto-clear a transient status message after `ms`. Pass the status value and a
// clearer (e.g. () => setStatus(null)). The timer is keyed ONLY on the value, so
// background re-renders (3s data polling) don't reset it — it resets only when a
// fresh message arrives, and a null value cancels it. `clear` is read via a ref
// so its changing identity each render doesn't retrigger the effect.
import { useEffect, useRef } from "react";

export function useAutoDismiss(value: unknown, clear: () => void, ms = 6000) {
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (value == null) return;
    const id = setTimeout(() => clearRef.current(), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
}
