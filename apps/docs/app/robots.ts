import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';

// A static export prerenders a metadata route only when it is marked static.
export const dynamic = 'force-static';

const crawlers = [
  'Googlebot',
  'Bingbot',
  'Applebot-Extended',
  'Google-Extended',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...crawlers.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
