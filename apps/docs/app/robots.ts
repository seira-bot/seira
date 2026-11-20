import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';

// A static export prerenders a metadata route only when it is marked static.
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
