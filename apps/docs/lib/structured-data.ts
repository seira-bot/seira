import { getBreadcrumbItems } from 'fumadocs-core/breadcrumb';
import { source } from './source';
import {
  appName,
  docsRoute,
  githubUrl,
  msStoreUrl,
  organizationName,
  organizationUrl,
  playStoreUrl,
  siteUrl,
} from './shared';

type Page = NonNullable<ReturnType<typeof source.getPage>>;

function breadcrumbList(page: Page) {
  const tree = source.getPageTree();
  const trail = getBreadcrumbItems(page.url, tree, { includePage: true });
  const items = [{ name: appName, url: docsRoute }];
  for (const item of trail) {
    if (typeof item.name !== 'string' || !item.url || item.url === docsRoute) continue;
    items.push({ name: item.name, url: item.url });
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${siteUrl}${item.url}`,
    })),
  };
}

const organization = {
  '@type': 'Organization',
  '@id': `${organizationUrl}/#organization`,
  name: organizationName,
  url: organizationUrl,
  logo: `${siteUrl}/app-icon-512.png`,
  sameAs: [githubUrl, msStoreUrl, playStoreUrl],
};

const website = {
  '@type': 'WebSite',
  '@id': `${siteUrl}/#website`,
  name: appName,
  url: siteUrl,
  inLanguage: 'en',
  publisher: { '@id': organization['@id'] },
};

export function pageStructuredData(page: Page) {
  const modified = page.data.lastModified;
  const article = {
    '@type': 'TechArticle',
    headline: page.data.title,
    description: page.data.description,
    url: `${siteUrl}${page.url}`,
    mainEntityOfPage: `${siteUrl}${page.url}`,
    inLanguage: 'en',
    image: `${siteUrl}/og/docs/${[...page.slugs, 'image.png'].join('/')}`,
    publisher: { '@id': organization['@id'] },
    ...(modified ? { dateModified: modified.toISOString() } : {}),
  };
  const graph: object[] = [article, breadcrumbList(page)];
  if (page.slugs.length === 0) graph.push(website, organization);
  return { '@context': 'https://schema.org', '@graph': graph };
}

