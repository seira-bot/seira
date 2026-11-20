import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;
// A static export prerenders a route handler only when it is marked static.
export const dynamic = 'force-static';

export function GET() {
  return new Response(llms(source).index());
}
