import { useLayoutEffect, useState, type RefObject } from "react";

/** Simple: anything that grows the card past its one-line height (a second line, a reply strip) rounds its corners in. */
export function useTallPill(shellRef: RefObject<HTMLDivElement | null>, on: boolean, oneLine = 44.5): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!on || !shell || typeof ResizeObserver === "undefined") return;
    const measure = () => setTall(shell.getBoundingClientRect().height > oneLine);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellRef, on, oneLine]);
  return tall;
}
