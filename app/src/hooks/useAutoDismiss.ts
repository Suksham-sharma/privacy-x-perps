"use client";
// Auto-clear a transient status after `ms`, keyed ONLY on the value so polling
// re-renders don't reset the timer (null cancels; `clear` read via ref).
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
