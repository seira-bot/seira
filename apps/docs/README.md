# Seira documentation

The public documentation site is a Next.js 16 + Fumadocs app. User-facing content lives in `content/docs`; the repository's top-level `docs` folder remains available for implementation notes and detailed platform records.

## Develop

From the repository root:

```bash
pnpm install
pnpm docs:dev
```

The site opens at `http://localhost:3000`.

## Verify

```bash
pnpm docs:build
pnpm --filter @seira/docs types:check
pnpm --filter @seira/docs lint
```

The build writes a static site to `out/`. No server runs: search uses a static
index, and the redirects are in `public/_redirects`.

The changelog reads published releases from `seira-bot/seira` during the build.
It shows the releases that exist when the site was last built. If GitHub is
unavailable during the build, the page links directly to the releases.

## Deploy to Cloudflare

The `seira-docs` Worker serves `out/` at `docs.seira.bot` (`wrangler.jsonc`).
It is an assets-only Worker with no script, binding or secret. This deploys
only the public documentation. It does not deploy the Electron app, local
harness, credentials, agents, or user data.

A merge to `main` does not deploy the site. Deploy by hand from a clean checkout
of `main`, with `CLOUDFLARE_ACCOUNT_ID` set to the account that holds the
`seira.bot` zone:

```bash
pnpm install --frozen-lockfile
pnpm docs:build
cd apps/docs && pnpm dlx wrangler@4.123.0 deploy
```

Deploy again after a docs change merges and after each desktop release, so the
changelog lists the new release.
