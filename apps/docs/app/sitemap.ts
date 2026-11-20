import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

// A static export prerenders a metadata route only when it is marked static.
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => {
    const lastModified = page.data.lastModified;
    return { url: `${siteUrl}${page.url}`, ...(lastModified ? { lastModified } : {}) };
  });
}
