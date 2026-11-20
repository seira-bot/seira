import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * The site builds to static files in out/, which the seira-docs Worker serves (wrangler.jsonc).
 * A static export has no server, so redirects live in public/_redirects.
 * @type {import('next').NextConfig}
 */
const config = {
  output: 'export',
  reactStrictMode: true,
};

export default withMDX(config);
