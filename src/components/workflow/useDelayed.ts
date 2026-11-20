import { useEffect, useState } from "react";

const SPINNER_DELAY_MS = 300;

export function useDelayed(active: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return setLate(false);
    const timer = window.setTimeout(() => setLate(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return active && late;
}
