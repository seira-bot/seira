'use client';

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { useMemo } from 'react';
import { useI18n } from 'fumadocs-ui/contexts/i18n';

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  // The dialog stays mounted because its trigger buttons open it. Only the search engine loads on the first query.
  const client = useMemo(
    () => ({
      deps: [locale],
      async search(text: string) {
        const { staticClient } = await import('fumadocs-core/search/client/orama-static');
        return staticClient({ locale }).search(text);
      },
    }),
    [locale],
  );
  const { search, setSearch, query } = useDocsSearch({ client });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
