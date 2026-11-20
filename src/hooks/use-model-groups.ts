import { useEffect, useState, type RefObject } from "react";

export function useModelGroups<T extends { instanceId: string }>(menu: RefObject<HTMLElement | null>, onOpen: (instance: T) => void) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<{ instance: string; id: number }>();
  useEffect(() => {
    if (!shown) return;
    const group = [...(menu.current?.querySelectorAll<HTMLElement>("[data-simple-provider]") ?? [])].find((node) => node.dataset.simpleProvider === shown.instance);
    group?.scrollIntoView({ block: "start" });
    group?.querySelector<HTMLElement>("[data-menu-row]")?.focus({ preventScroll: true });
  }, [menu, shown]);

  const toggle = (instance: T) => {
    const opening = !expanded.has(instance.instanceId);
    setExpanded((current) => {
      const next = new Set(current);
      if (opening) next.add(instance.instanceId);
      else next.delete(instance.instanceId);
      return next;
    });
    if (opening) onOpen(instance);
  };
  const reveal = (instance: T) => {
    if (!expanded.has(instance.instanceId)) toggle(instance);
    setShown((current) => ({ instance: instance.instanceId, id: (current?.id ?? 0) + 1 }));
  };
  return { expanded, toggle, reveal, collapseAll: () => setExpanded(new Set()) };
}
