import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;
// A static export prerenders a route handler only when it is marked static.
export const dynamic = 'force-static';

export const { staticGET: GET } = createFromSource(source, {
  language: 'english',
});
