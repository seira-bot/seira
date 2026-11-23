import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { getPageImageUrl, source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';

export const revalidate = false;
// A static export prerenders a route handler only when it is marked static.
export const dynamic = 'force-static';

const colors = {
  background: '#070708',
  ink: '#f4f4f5',
  muted: '#9a9aa4',
  line: '#232327',
  accent: '#3fae6e',
};

function sectionName(url: string) {
  const [first] = getBreadcrumbItems(url, source.getPageTree());
  return typeof first?.name === 'string' ? first.name : 'Documentation';
}

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const icon = await readFile(path.join(process.cwd(), 'public/app-icon-192.png'));
  const iconSrc = `data:image/png;base64,${icon.toString('base64')}`;
  const title = page.data.title;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          color: colors.ink,
          backgroundColor: colors.background,
          backgroundImage: `radial-gradient(circle at 85% 0%, rgba(63,174,110,0.28), rgba(7,7,8,0) 55%)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <img src={iconSrc} width={72} height={72} style={{ borderRadius: 18 }} />
          <div style={{ display: 'flex', marginLeft: 22, fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>Seira</div>
          <div
            style={{
              display: 'flex',
              marginLeft: 20,
              padding: '6px 18px',
              fontSize: 22,
              letterSpacing: 4,
              color: colors.muted,
              border: `2px solid ${colors.line}`,
              borderRadius: 999,
            }}
          >
            DOCS
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', fontSize: 30, letterSpacing: 5, color: colors.accent }}>
            {sectionName(page.url).toUpperCase()}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 24,
              fontSize: title.length > 28 ? 76 : 96,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: -2,
            }}
          >
            {title}
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: colors.muted }}>docs.seira.bot</div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
