'use client';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { SharedProps } from 'fumadocs-ui/components/dialog/search';
import { lazy, useEffect, useState, type ReactNode } from 'react';

const SearchDialog = lazy(() => import('@/components/search'));

// The search index and its engine load when the reader first opens search.
function LazySearchDialog(props: SharedProps) {
  const [wanted, setWanted] = useState(props.open);
  useEffect(() => {
    if (props.open) setWanted(true);
  }, [props.open]);
  return wanted ? <SearchDialog {...props} /> : null;
}

export function Provider({ children }: { children: ReactNode }) {
  return <RootProvider search={{ SearchDialog: LazySearchDialog }}>{children}</RootProvider>;
}
