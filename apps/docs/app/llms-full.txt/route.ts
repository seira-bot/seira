import { getLLMText, source } from '@/lib/source';

export const revalidate = false;
// A static export prerenders a route handler only when it is marked static.
export const dynamic = 'force-static';

export async function GET() {
  const scanned = await Promise.all(source.getPages().map(getLLMText));
  return new Response(scanned.join('\n\n'));
}
