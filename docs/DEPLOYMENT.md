# Deploying ASCII Atlas to Vercel

The app exports static HTML, JavaScript, workers and map assets. The web build fetches the files pinned by each city's `tiles.lock.json` from GitHub Releases, verifies their hashes, then runs Next's static export. Vercel serves the resulting files.

## Project settings

Import `oroalej/map-ascii` through Vercel's GitHub integration. Use these settings for this project:

| Setting | Value |
| --- | --- |
| Framework Preset | Next.js |
| Root Directory | `apps/web` |
| Include source files outside Root Directory in the Build Step | Enabled |
| Install Command | `pnpm install --frozen-lockfile` (committed in `apps/web/vercel.json`) |
| Build Command | `pnpm build && pnpm check:budgets` (committed in `apps/web/vercel.json`) |
| Output Directory | Framework default; leave the override disabled |
| Node.js Version | 22.x; package engines also restrict builds to Node 22.13 or newer within major 22 |
| Production Branch | `main` |
| Skip unaffected projects | Disable initially: the build reads root scripts and the data package as well as runtime workspace dependencies |

Enable `ENABLE_EXPERIMENTAL_COREPACK=1` in Preview and Production so Vercel uses the root `packageManager` pin, currently `pnpm@9.15.1`. Install the full workspace including development dependencies: the build needs `tsx` and the data package. Keep the Next.js framework's output detection; the app already sets `output: 'export'` and writes `apps/web/out`.

The repository and its release assets are public, so no GitHub token is required. If the repository becomes private, configure a secret `GITHUB_TOKEN` with read access to its release assets in Preview and Production. Never give that variable a `NEXT_PUBLIC_` prefix.

`NEXT_PUBLIC_LIFE_HOVER_PAUSE` is optional. Unset/empty or `item` uses normal item inspection; `all` restores the global hover pause. Changing it requires rebuilding the deployment.

The repository-root `vercel.json` retains equivalent tile headers for other tooling. The supported project setup above uses `apps/web/vercel.json`. Keep the two files' header rules synchronized.

References: [Vercel build settings](https://vercel.com/docs/builds/configure-a-build), [monorepos](https://vercel.com/docs/monorepos), [Node versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Preview and launch

1. Push the deployment branch and open a PR. Verify the Vercel preview's commit matches the PR head. For the initial setup, validate this preview before publishing the production site.
2. Check that the build uses Node 22 and pnpm 9.15.1, downloads the pinned assets and passes `check:budgets`. A missing or invalid release asset fails the build; fix publication or the lock through the normal data workflow.
3. Open `/`, `/naga`, and a shared view copied from the app. Verify the root redirect preserves parameters, refreshing a city URL works, and an unknown city returns 404.
4. Verify the map draws with OSM attribution, and try search, landmark facts, a verified tour, and a shared URL. Check browser Network and Console for missing workers, scripts, sidecars or errors. Repeat on a phone for launch acceptance; use the existing smoke tests for automated checks.
5. Check PMTiles range delivery and cache headers as described below. Reload the same view to confirm the worker reuses its CacheStorage ranges when browser storage is available.
6. Wait for all PR CI checks and the preview deployment to pass. Merge through `$merge-pr`. Vercel's Git integration deploys `main` independently of GitHub Actions, so enforce PR checks before merging; do not assume Vercel waits for main's CI.
7. Verify the production deployment uses the merged commit, then repeat route and tile-response checks on its production URL. Start with the assigned `vercel.app` address; add a custom domain through project Domains when one is chosen.

Use the existing targeted desktop smoke tests locally. Full unit and browser suites remain in PR CI. No screenshots or additional capture harnesses are needed.

## Check tile delivery

Read the PMTiles URL from the browser's Network panel. A locked archive carries `?v=<first eight hex characters of its SHA-256>`. Use the deployed URL and current pin, not a stale example.

From PowerShell, use `curl.exe` to send a real GET range request:

```powershell
curl.exe --silent --show-error --dump-header - --output NUL --header 'Range: bytes=0-16383' 'https://<deployment>/tiles/naga.pmtiles?v=<pin>'
```

Expect status `206`, `Content-Range: bytes 0-16383/<archive size>`, and `Cache-Control: public, max-age=31536000, immutable`. Check the returned range length too. Repeat without `?v=...`; its cache policy must revalidate (`max-age=0, must-revalidate`). Verify JSON sidecars return JSON successfully and have browser revalidation with the configured CDN cache policy. Vercel may consume CDN directives rather than expose them unchanged to the browser.

Preserve range delivery when editing header or routing configuration. A 200 response containing the whole archive, an HTML rewrite, or authentication HTML at a tile URL is a failed deployment check. Preview protection must allow the browser and any HTTP check to access the same preview; do not publish a protection bypass secret in documentation or logs.

The worker keeps exact ranges in CacheStorage separately from the browser's HTTP cache. Inspect its range entries and repeat the same view with storage available; cache hits should avoid new network downloads for those ranges. Storage failure is supported through network fallback.

## Releases and recovery

Normal updates use branch previews and a reviewed merge to `main`. Publish changed geographic data and lazy facts/tours through `pnpm data:publish`, commit the resulting lock, and deploy the code and lock together. Publishing a GitHub release alone does not update the website.

Record the production URL, deployment ID and Git commit in the task's progress notes. Keep the previous successful deployment available. For a production regression, use Vercel's rollback to a known-good deployment, then fix the branch and redeploy. The previous deployment contains its own exported map assets. On the initial launch there is no previous production deployment to roll back to.

For the hover inspection fallback, rebuild with `NEXT_PUBLIC_LIFE_HOVER_PAUSE=all`; changing an environment variable alone does not modify an existing export.

References: [deployment environments](https://vercel.com/docs/deployments/environments), [instant rollback](https://vercel.com/docs/instant-rollback).
