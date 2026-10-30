# Bring an existing site to Ploy

Use your own coding agent. CLI code sync is free: it connects directly to the
site's Ploy repository without requiring GitHub Code Sync. A GitHub account and
the paid GitHub Code Sync integration are optional.
These commands require a CLI and server release containing `ploy site git`.
Check `ploy --version` and `ploy site git --help` before starting. The help
must list `clone` and `sync`; older versions can print parent help without
failing. Upgrade through the installer if needed. If the server does not
support these commands, report the release blocker rather than creating sites
repeatedly or switching to a paid integration.

For an existing Ploy site changing workspaces, use
[workspace transfer](workspace-transfer.md) for its dependencies and cutover.

## Assess compatibility and choose scope

Inspect the source checkout, committed tree, framework configuration, routes,
and backend dependencies before creating a destination. If given a GitHub URL,
clone it separately using the user's existing GitHub access. Record the source
commit and any uncommitted changes the user wants included.

Offer the applicable paths, respecting scope already chosen by the user:

- **Whole site:** map every route and behavior to the Ploy runtime. Identify
  replacements needed for server features before starting the port.
- **Selected pages:** name the pages, shared components/assets, and server
  dependencies being moved. Keep links to excluded pages on their original
  origin; record canonical URLs and redirects. Routing only selected paths of
  a live domain to Ploy requires a separate routing/cutover decision.
- **Keep the current framework:** explain incompatibilities and stop the port
  if the user requires that framework. Git sync does not translate runtimes.

An Astro dependency alone does not establish compatibility. Compare adapter,
build configuration, environment access, and server dependencies against the
Ploy starter. Generic Astro, Next.js, Vite/React, and other sites use the separate
starter checkout below, reusing compatible code and replacing framework behavior.
For frameworks without a mapping here, assess the actual features; do not promise
an automatic conversion.

An already Ploy-compatible repo can instead use `ploy site init --from <path> --wait --json`. Inspect that command's help first. It imports committed HEAD at
the repository root, not uncommitted files or a monorepo subdirectory. Check the
committed `package.json`, `astro.config.mjs`, pages, runtime configuration, and
build before import. The import creates fresh history rather than linking the
original GitHub repository. Reuse any returned site ID on partial failure.
Select the created site and use `ploy site git clone` for subsequent local work.

For an existing checkout bound by `ploy site git clone`, inspect its
`ploy.site`, `ploy.workspace`, and `ploy.apiurl` Git config and reuse it. Skip
creation and migration when the request is simply another local edit or sync.

## Create the destination

```sh
curl -fsSL https://ploy.ai/install.sh | sh
ploy login
ploy workspace list
```

Login opens Ploy's normal sign-in/sign-up page. A new user creates their account
there and authorizes the CLI; the agent must let the human complete identity
verification. Subsequent Git operations use that login automatically.

Verify the API origin and intended workspace before creating sites. Access to a
staging workspace does not establish access to the user's production organization.
For a multi-site test, record each source, destination ID, and checkout binding.

Select the intended workspace with `ploy workspace use --id <workspace-id>`.
If there are none, run `ploy workspace create --name "My website" --json`, then
select the returned workspace ID. Inspect the returned `defaultSiteId` with
`site status` before cloning: the default can remain unprovisioned and Git clone
can fail. Reuse it if ready. If it is verified empty with no usable repository,
create the intended destination with `site init` below, record both IDs, and
include the unused default in the authorized cleanup.
For an existing workspace that needs a new destination:

```sh
ploy site init --name "My website" --wait --json
ploy site use --id <site.id-from-init>
ploy site git clone ../my-website-ploy
cd ../my-website-ploy
```

Create one destination per source site in the requested scope. If init times out, keep the returned
site ID, inspect `ploy site status --id <site-id> --json`, and reuse it. Do not
retry site creation to poll readiness. Cloning requires the starter's first
durable commit; wait for the site to be ready.

If provisioning remains degraded, open the existing site's dashboard and use
**Open in a Ploy** when available, then recheck readiness with a bounded wait.
Reuse the same site ID; report the blocker if recovery fails.

The new checkout has a `ployspace` remote and a site binding in `.git/config`.
The URL contains no credential. Git asks the CLI for a fresh credential, scoped
to that site for 15 minutes. Do not copy the source project's `.git`, replace
this remote, or move its unrelated history into Ploy's `main`.

## Migration contract for coding agents

Treat the source repo as input and edit only the destination. Inspect the
source's current framework before choosing the path; a repo described as Next.js
may already contain an Astro conversion. Record the exact source commit and
uncommitted work you intend to include. Keep source docs as reference material;
their deployment instructions do not replace this destination's contract.

Before editing, make a route and behavior inventory from the source:

- All pages and dynamic routes, content slugs, redirects with status codes,
  query parameters, anchors, sitemap, robots, and public assets.
- Shared layouts, fonts, responsive breakpoints, navigation, interactive
  islands, forms, and external links.
- API routes, server actions, middleware/proxy, rewrites, cookies, headers,
  authentication, environment variables, analytics, and consent behavior.

For every entry in the selected scope, name its destination and how it will be
verified. Record excluded routes explicitly. Call out
server features that need a replacement before presenting the migration as
complete. A screenshot alone does not verify a form, redirect, or consent gate.

### Existing Astro

Port routes, components, content, assets, and styles into this starter. Merge
dependencies and required integrations. Preserve the destination's runtime
configuration: Astro SSR with the Cloudflare adapter, literal `site`,
`build.assets: "_ploy_static/_astro"`, React's Workers-compatible SSR settings,
the session driver, and generated `wrangler.toml` precedence over the checked-in
local Wrangler fallback. Keep local `assets.html_handling` set to `drop-trailing-slash` to match Ploy publishing. Keep platform-owned `public/_headers` and `.assetsignore` when copying source assets. Preserve the `ploy-web` package name and the named
verification/build scripts. Integrate content generation through a prebuild
step if needed. Lockfile rule: `bun.lock` is the sandbox's canonical lockfile
and must be regenerated with every dependency change. Regenerate
`package-lock.json` in the same commit only while the destination still tracks
it; once sandbox startup has deleted it, do not reintroduce it (see the sync
section below).

Compare the actual major versions and integration APIs, including Markdown
processors and syntax-highlighter plugins. Keep plugin versions compatible
with the host runtime rather than copying source version ranges wholesale.
A source glob over all `public/*` files may accidentally import Ploy's
`_headers` as JavaScript; restrict image discovery to image files.

Static search and generated social images need an explicit build lifecycle.
Pagefind must index the adapter's rendered client HTML, not the server bundle.
Keep its assets available in the editor preview, regenerate them after content
changes, and exclude generated distributions from source linting. Node-only
image tools cannot run inside Workers even during Worker-based prerendering;
use the adapter's supported Node build path and serve generated assets in the
Worker preview, or implement a Worker-compatible generator. Test both paths.

If the actual preview serves raw TypeScript or CSS for Astro script/style query
URLs, inspect the failed requests before changing application logic. Standalone
browser modules and CSS imports can avoid that transport problem. Preserve and
retest navigation, transitions, theme initialization, and search; removing those
features to make the page load is not a completed migration.

### Next.js

Reuse framework-independent React components and content. Port routing and
server behavior explicitly:

| Source                             | Destination                                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Router page / layout           | Thin `src/pages/*.astro` route plus Astro layout; remove route-group segments from URLs                                                                        |
| `next/link`                        | Ordinary anchor or equivalent navigation with the same URL, query and hash behavior                                                                            |
| `next/image`                       | Astro image tooling or sized `<img>`; preserve responsive sizing, alt text, and loading priority                                                               |
| `next/font`                        | Local or packaged fonts with the same weights, CSS variables and fallback metrics                                                                              |
| Browser hooks, state, motion       | React island with the necessary `client:*` directive; `"use client"` alone does not hydrate Astro                                                              |
| Shared React context               | One common island for consumers; context does not cross separate islands                                                                                       |
| Metadata API                       | Astro layout head including canonical, social cards, JSON-LD, icons and noindex                                                                                |
| MDX / dynamic content              | Explicit collections in `src/content.config.ts`; preserve slugs, heading IDs, tables and draft filtering                                                       |
| `generateStaticParams`             | SSR parameter lookup for growing collections; `getStaticPaths` only for bounded prerendered routes                                                             |
| Route handler / server action      | Cloudflare-compatible Astro endpoint or supported Ploy feature with equivalent validation and authorization                                                    |
| `next.config` redirects            | Astro redirects or Ploy domain routing; use explicit status 308 for Next permanent redirects (Astro string redirects default to 301), test in the built Worker |
| Rewrites / middleware / `proxy.ts` | Explicit Worker-compatible replacement or Ploy routing rules, with an identified deployment prerequisite                                                       |
| `NEXT_PUBLIC_*`                    | Deliberately mapped `PUBLIC_*`; private values remain server-only                                                                                              |

Contentlayer and Astro derive IDs differently. Preserve source slugs explicitly,
including punctuation and nested paths, and compare the full route inventory.
Rename source metadata fields that collide with Astro semantics, such as a
frontmatter `layout` used only as a React layout selector. A hydrated React
component must be statically imported by Astro; put dynamic layout selection
inside an imported React wrapper. Verify MDX components, heading IDs, code-copy
controls, math, citations, draft filtering, feeds, and search after the port.
Shared React providers require the same runtime package instance as consumers;
duplicate versions or module resolution can split their context.

Do not carry Next, Vercel, Node-only adapters, `.next`, `node_modules`, source
workflows, or source lockfiles wholesale into the destination. Never copy
secrets, actual `.env` files, credentials, or source Git history. Use
`ploy variable`, `ploy secret`, or `ploy env` for environment configuration.
If a source integration depends on a paid custom domain, record that dependency
and provide an equivalent free-hosting path or mark that integration incomplete.

### Vite / client-only React

Mount connected components under a shared React island so context and state
remain shared. Make browser-only initialization safe for server rendering, then
check hydration in the browser. Invalid DOM or SVG nesting tolerated by a
client-only app can cause hydration to discard server-rendered HTML even when
the build passes. Keep the original interaction semantics: a demo form is not
a working backend integration.

When porting Tailwind 3 styling into this starter's Tailwind 4 setup, compare
computed layout and both themes. Translate configuration, container widths,
and arbitrary values explicitly; comma-separated grid tracks need the current
space/underscore syntax. Check responsive menus and repeated spacing as well
as the first screen. Verify asset imports in the actual Ploy preview: if a
Vite `?url` image import fails there despite a passing build, serve the image
from `public/` using a stable URL, or verify a supported Astro asset import.
Restart a running built Worker preview after rebuilding
if it retains the previous asset manifest.

### Nuxt, Vue, SvelteKit, and Svelte

Treat these frameworks as behavior and design inputs, then implement the
selected scope in the destination Astro starter. Do not transplant their
runtime, routing conventions, or server configuration. Reuse portable content,
styles, public assets, and framework-independent logic where doing so preserves
behavior.

Extend the route inventory with framework-owned behavior: Nuxt/Nitro server
routes and modules, SvelteKit endpoints and hooks, private environment access,
image-provider APIs, form services, PWA/service-worker behavior, and
framework-specific or licensed animation plugins. For each dependency, choose
a Worker-compatible implementation, a Ploy-native replacement, or an explicit
fidelity gap before calling the port complete. Typical replacements include a
private image-listing API with verified public CDN assets, an external form
provider with Ploy's form collector, and licensed animation plugins with local
CSS or hydrated React behavior. Never infer permission to copy credentials.

Verify the built Worker rather than the source framework's dev server: exercise
every selected route and redirect, responsive navigation, filters, dialogs or
lightboxes, forms without creating external data unless authorized, metadata,
public assets, and the authenticated Ploy editor preview. Keep approximation
boundaries in the final handoff instead of presenting visual similarity as
runtime parity.

## Verify, push, and continue editing

Run `npm run verify` in the destination, then run `npx wrangler deploy --dry-run`
from the same checkout without cleaning `dist`. The dry run does not read the
local fallback `wrangler.jsonc` directly: the build emits
`dist/server/wrangler.json` (with `main` and `assets.directory`) and a
`.wrangler/deploy/config.json` redirect, and Wrangler follows that redirect.
Running it before a build, or after removing `dist`, fails with a
deploy-configuration error rather than testing anything. The dry run must
package the generated Worker successfully; it does not deploy. Also inspect rendered output and build errors:
React rendering failures can be logged while the build exits zero and emits
empty HTML. Require nonempty page content and the expected headings, not just
HTTP 200. Record pre-existing source failures separately from migration
regressions. Make date formatting deterministic between server and browser.

Fix failures, including content
collection discovery and Cloudflare Worker build errors. Then run the built
site with `npm run preview` and test the route inventory. Check desktop and
mobile, menus, forms, content headings/search, 404s, redirect HTTP status,
metadata, fonts, assets, and consent/analytics behavior. Test privacy states
with their relevant environment configuration; a disabled integration is not
evidence that it works.

```sh
git status --short
git add <reviewed-migration-files>
git commit -m "Migrate website into Ploy Astro starter"
git pull --rebase ployspace main
npm run verify
git push ployspace HEAD:main
ploy site git sync --json
```

For this external CLI checkout, rebasing your unpublished local commits onto
`ployspace/main` is the normal workflow. Keep the worktree clean first. Re-run
`npm run verify` after every rebase that changed HEAD, even a conflict-free one:
Git only reports textual conflicts, and editor commits can still break the
combined tree. Push only a verified HEAD. If a rebase conflicts, resolve it and
re-run verification; never force-push to make the migration win over edits
from the Ploy editor. The source repo's history stays outside this checkout.

Sync verifies local HEAD in durable `main` and in editor history. The editor
may have additional autosave commits, so its HEAD can be a descendant. Sync
then restarts the preview through its supervisor, which installs dependencies
and reloads the Astro configuration and content graph. A `preview: "restarting"`
response confirms the restart was accepted; it is not a rendered-page health
check. Wait for the preview and test it before declaring the migration complete.
The sandbox uses `bun.lock` as its canonical lockfile; current startup removes
`package-lock.json`. Pull that editor change before further local commits, and
from then on regenerate only `bun.lock` for dependency changes in this
destination; the starter's regenerate-both rule applies only while both
lockfiles are still tracked.
If sync says the commit is not on main just after a successful push, compare
`git rev-parse HEAD` with `git ls-remote ployspace refs/heads/main`. When they
match, retry sync after a short wait, with a bounded retry count. If they differ
or retries fail, report both SHAs and the error; never force-push or recreate
the site to bypass verification. Other sync failures need their reported
conflict or preview issue resolved. Pull editor changes before the next local edit.
Expired Git credentials renew automatically while the CLI login is valid; if
the login expires, run `ploy login` for the same API origin.

Open the dashboard URL returned by site init and confirm the migrated site is
editable. Publishing is a separate step, run when the user has requested it. Confirm the
selected workspace and site match the checkout binding before running
`ploy site publish --wait`; sync uses the checkout binding, but publishing uses
the CLI selection. Inspect the publish result and live URL before claiming it
is deployed.
Report the source commit, verified commit, build/browser results, and any
unmigrated behavior. No claim of deployment success is justified by local build
or Git sync alone.

The original GitHub repo remains a source snapshot. Later source changes need an
explicit port into the migrated checkout; this workflow does not maintain two
different framework implementations automatically. Optional GitHub Code Sync
connects a Ploy-compatible site and does not remove these migration requirements.
Read the destination checkout's `AGENTS.md` for its current conventions.
