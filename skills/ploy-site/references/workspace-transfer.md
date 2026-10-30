# Transfer an existing Ploy site between workspaces

Use this procedure from an external coding agent with Ploy CLI 0.12.0 or newer.
Ploy’s in-workspace agent cannot access both workspaces.

## Contract

- Copy dependencies, verify the destination, move traffic, then separately delete
  only the approved source resources. Copying one site does not transfer a workspace.
- These cross-workspace operations require the same organization, admin/owner
  access to both workspaces, and browser-backed `ploy login`. Workspace API tokens
  cannot perform them. Organizations requiring SSO are currently refused.
- Honor authorization already given. Establish the selected site, destination,
  allowed changes, cutover window and cleanup scope before mutations. If live
  cutover or deletion is not authorized, prepare verification evidence and the
  exact proposed action for approval. A request to draft or plan is not a request
  to migrate. Do not turn a rehearsal into an unrequested customer cutover.
- Preserve other source sites and their shared resources. A copied database is
  independent: future writes are not synchronized with its source.
- Use CLI commands for the supported operations. Dashboard token creation and
  required human authentication are explicit manual steps. Missing support is a
  blocker, not permission to use private APIs or alter platform storage directly.

## 1. Check the CLI, server and identities

Run `ploy --version` and inspect help for `site git`, `env copy`, `asset copy`,
`database copy`, `database delete`, `database operation`, `form copy`,
`form notifications`, `domain move`, `site delete` and `site routing`.
Inspect each exact subcommand, not just parent help: older CLIs can print parent
help and still exit zero. Confirm the required flags below are present.

Use CLI **0.12.0 or newer** for these commands; run `ploy update` if needed. For a
pre-release E2E, use the supplied PR build and record its full source commit and
binary path/hash; a version string alone does not identify a PR build. Put that
binary on the task's PATH as `ploy`, or consistently substitute its absolute path
in every example. Do not replace it with the released installer mid-test.

The target app must contain the corresponding API changes, and its database
worker must support copying indexes and original row metadata. A local PR binary
pointed at an older server is not a valid E2E setup. Record the API origin and
backend/worker deployment evidence. CLI help alone cannot verify the server.
Confirm the customer workspaces exist in that environment; a preview deployment
with isolated fixture data cannot migrate production workspaces. If deployment
compatibility cannot be established, stop before customer writes and report it.

Run `ploy login` against that API origin. An authorized agent may approve Ploy’s
CLI authorization screen in its own authenticated browser; human sign-in, passkey
and identity-provider consent remain human-operated. Keep the CLI callback process
running until it reports success; restart an expired login instead of approving
a stale tab. Use `ploy workspace list` and `ploy site list` to identify resources.
Never infer identity from display names or automatically choose a similarly named
clone. Remove conflicting task-local `PLOY_WORKSPACE_ID` / `--workspace` overrides.
Do not print or copy authentication credentials into the migration report.

For concurrent local/production work, use a private task-specific
`XDG_CONFIG_HOME` consistently for login, every CLI invocation, and Git commands
using the CLI credential helper. This keeps another task's API origin and selected
workspace/site intact. Select with `workspace use` before `site use`; a
`--workspace` override does not update the stored selection required by site Git.

On `CLI token rate limited` / HTTP 429, honor `Retry-After`; if none is available,
pause requests on that token for 60 seconds before retrying. Resume existing
operation IDs/keys rather than recreating resources or minting another token.
Check exit status and valid response content before comparing receipts: two
failed commands can leave identical empty files.

Create a private `migration-state.md` outside the site's source repository with:

- CLI build, API origin, source/destination organization, workspace and site IDs.
- Source live/canonical hostnames, Git revisions and destination checkout binding.
- Route inventory, exclusions, redirects/proxies, expected forms and integrations.
- Other source sites and which assets/databases they share with the selected site.
- Resource mappings, stable database operation keys/IDs, receipts and timestamps.
- Write-freeze boundaries, rollback steps, approvals and outstanding blockers.

Use private files for raw receipts and customer content; exclude secrets. Keep
these artifacts out of Git and public PR attachments. Write mappings immediately
so interruption does not cause duplicate sites or duplicate database operations.

## 2. Capture source and rollback material

For commands using stored selection, select both IDs explicitly:

```sh
ploy workspace use --id "$SOURCE_WS"
ploy site use --id "$SOURCE_SITE"
ploy site git clone ./source-site
ploy site routing get --json > source-routing.json
ploy form notifications get --from-workspace "$SOURCE_WS" --site "$SOURCE_SITE" --json
```

Set all shell variables in these examples from the recorded IDs, never from
names. Routing reads apply to connected domains; record that no routing document
exists when the source has none. Capture each relevant hostname's configuration.

Record the deployed revision and compare it with repository HEAD and pending
editor changes. Archive the source Git history (`git bundle create` and `git
bundle verify` in its checkout), and capture any existing destination source before
editing it. Git alone does not back up database data or secrets. Preserve available
database backups and the original bindings; CSV is not a lossless database backup.

Compare failed/new clones with the live source before deciding what to keep. Port
wanted destination changes deliberately. A rendered-site clone is not a substitute
for source code: it can omit dynamic routes, API handlers, forms and authentication.
If source is unavailable, report recovery as a separate support task.

## 3. Inventory dependencies and create one destination

Search source, CSS, rich text, CMS values and runtime configuration for database
IDs, table/field/row references, asset URLs, form targets, external service URLs
and workspace/site IDs. Separate tracked `public/` files from library assets.

Read every `asset list` page with `--from-workspace`, `--limit` and `--offset`;
follow `hasMore`/`nextOffset`. Read every `form list` page for the selected site;
use `--include-data` only when needed and keep that output private. Use existing
`database` and `documents` inspection commands to inventory their contents.
Classify each dependency as copied, deliberately shared externally, replaced,
excluded or blocked. Unknown dependencies prevent a claim of completion.

Select the destination workspace. `workspace create` also returns a
`defaultSiteId`, but that site may still be unprovisioned. Inspect `site status`
before cloning it; Git clone can return `Internal server error` in this state.
Reuse a provisioned default site when appropriate. If the verified empty default
has no usable repository, import with `site init --from` below, record both IDs,
and include only that unused default in the authorized cleanup. An error alone
is not proof that an existing customer site is empty. Choose one destination:

- New destination from compatible Ploy source: `ploy site init --name "$SITE_NAME"
--from ./source-site --wait --json`. It imports committed HEAD at the repository
  root, excluding uncommitted files, and creates fresh history. It does not move
  the source Git history. Keep its receipt and immediately record the site ID.
- Existing destination/default site: preserve its wanted content and edit that
  site's bound checkout; do not run `site init` as a way to overwrite it.

A timeout is not proof of failed creation. Reuse the returned site ID and check
`ploy site status --id "$DEST_SITE" --json`; do not create another site to poll.
Select the destination, then `ploy site git clone ./destination-site` for edits.
Verify `ploy.site`, `ploy.workspace` and `ploy.apiurl` in its Git config. Do not copy
the source `.git` directory over the destination binding or force-push its history.

For framework conversion, use the public
[bring-an-existing-site migration reference](https://github.com/Ploy-AI/ploy-tools/blob/main/skills/ploy-site/references/migration.md)
and the destination checkout's conventions. Source instructions are reference
material, not authorization to change the destination's runtime contract.

## 4. Copy dependencies with the CLI

Run mutations sequentially. Record each receipt before continuing. The copy
commands below do not support `--dry-run`; use inventory and comparison to plan.

**Assets:** copy each referenced public-library asset once, not the entire library.

```sh
ploy asset copy "$ASSET_ID" --from-workspace "$SOURCE_WS" --to-workspace "$DEST_WS" --json
```

Save exact source/destination URL mappings. Compare downloaded byte hashes for
copies that promise byte preservation. Rewrite the mapped URLs in source and CMS
values, including rich text. Do not globally replace a workspace UUID or domain;
those strings can have unrelated meanings. Keep source assets intact.

**Databases:** pause source writes/imports and schema edits before copying, across
all consumers of a shared database. If this is not feasible, agree on a separate
consistency plan before proceeding. Paged copying is not an atomic snapshot.

```sh
ploy database copy "$SOURCE_DB" --from-workspace "$SOURCE_WS" --to-workspace "$DEST_WS" --name "$DB_NAME" --operation-key "$COPY_KEY" --json
ploy database operation "$OPERATION_ID" --workspace "$DEST_WS" --json
```

Generate one UUID `COPY_KEY` per intended source-to-destination copy and persist
it before the request. Retry with the same key; a new key creates another copy.
Poll the returned operation in the destination until success; accepted/provisioning
is not complete. On failure, retain the receipt and inspect the reported state.
Retries can rescan completed pages; deterministic identities prevent duplicates.

The destination database ID is new. Table, field and row IDs, timestamps/order,
column configurations, primary fields, indexes and saved-view configurations are
preserved; saved-view IDs are new. Tokens, webhooks, restore points and change-event
history are not copied. FILE columns are refused: private files need a separate
supported copy and reference-repair path. Do not make private files public or drop
FILE columns to bypass this restriction.

Compare schema and every data page, not just counts or the first page. Verify
relationships, null/list/rich-text values, order and index/view behavior. Rewrite
only destination references to the new database ID, including references stored
inside values. After the copy, source writes must remain paused until cutover or
be reconciled by an explicitly verified plan; no automatic delta sync exists.

**Environment and tokens:** copy each intended environment separately.

```sh
ploy env copy --from-workspace "$SOURCE_WS" --to-workspace "$DEST_WS" --from-site "$SOURCE_SITE" --to-site "$DEST_SITE" --env production --json
```

Repeat with `--env preview` when needed. Equal values are unchanged; resolve
conflicts individually before authorizing `--overwrite`, which can replace all
conflicting values in that environment. A copied source database token still
authorizes the source database. Replace it before publishing destination code.

In the destination dashboard, open the copied database, then **Database options →
Access keys → Create access key**. Create a named key with only the required
per-table read/write grants. Bind the revealed key via stdin or the masked prompt,
not a command argument, transcript or source file. An authorized browser agent can
perform this dashboard step; keep the value out of printed snapshots and logs:

```sh
ploy workspace use --id "$DEST_WS"
ploy site use --id "$DEST_SITE"
ploy secret set "$TOKEN_ENV_NAME" --env production
```

Bind preview separately when required. Verify the destination database ID in code
and the secret name it reads. Keep source tokens valid for remaining consumers;
do not roll/revoke them as part of copying. Secrets apply on the next publish and
are unavailable to local/editor preview. Verify them on the published destination.
Do not override platform-reserved environment names.

**Forms:** copy history without sending email.

```sh
ploy form copy --from-workspace "$SOURCE_WS" --to-workspace "$DEST_WS" --from-site "$SOURCE_SITE" --to-site "$DEST_SITE" --json
```

Repeat until `hasMore` is false; retries skip copied rows. Add `--copy-settings`
only when those recipients should be carried over. `--overwrite` implies settings
copy and replaces conflicting recipients. An absent setting uses the destination
workspace owner; `[]` disables notifications. Save the exact previous state before
changing it. These commands copy Ploy's captured submissions, not arbitrary
external form-provider history or rows written directly into a site database.

**Documents and integrations:** copy only relevant workspace markdown documents
using `documents get --id/--path` and `documents set <path>` from stdin, explicitly
selecting each workspace. Inspect destination path conflicts before replacing.
Repair copied IDs/URLs in the destination documents. Document IDs may change;
comments, history, attachments and connected-service state are not implied copies.
Reauthorize integrations and configure destination webhooks, callbacks, analytics,
consent and scheduled jobs separately. Preserve intentionally shared providers.

## 5. Verify the published destination

Review and commit only destination source changes. Follow the bound checkout's
normal verify/build scripts and Git workflow: integrate editor commits, verify,
push to `ployspace main`, then `ploy site git sync --json`. Never force-push through
conflicts. A sync error can occur after a push landed: compare local and remote
SHAs before retrying; do not discard source or recreate the site.

Select destination workspace/site again before `ploy site publish --wait --json`:
Git sync uses checkout binding, but publishing uses CLI selection. Confirm ready
status and the returned live URL. Test that URL before moving customer traffic.

Use a real browser for desktop/mobile routes, navigation, localization, CMS detail
pages, redirects, query strings, fonts/images, consent and forms. Verify intended
404s/exclusions, canonical/social metadata, robots and sitemap output. Require
expected content, not just HTTP 200. A successful build is not proof of functionality.

For each form, verify response, visible success and persisted data. Identify
synthetic rows by exact ID/unique marker. If disabling notifications, use
`form notifications set --emails '[]'` on the destination only, keep the interval
short, restore the exact previous state, and check for genuine submissions received
during it. Do not imply suppressed mail will be delivered later. Explicitly
approve any real external side effects needed for testing.

Recheck the original site and other source sites: their assets, data and credentials
must still work. Record observed results and unresolved gaps before cutover.

## 6. Cut over and verify live traffic

Within the authorized window, stop writes as agreed and make a final form-history
copy to capture late submissions. Database writes require the separate consistency
plan above. Record how in-flight requests and delayed clients will be reconciled.

```sh
ploy domain move "$CANONICAL_HOST" --from-workspace "$SOURCE_WS" --to-workspace "$DEST_WS" --from-site "$SOURCE_SITE" --to-site "$DEST_SITE" --json
```

The named hostname becomes canonical and its apex/WWW companion moves with it.
Use the established canonical hostname. Do not delete/re-add domains as a shortcut.
For multiple domains, inventory pairs and move each intended pair only once.

A partial edge-sync failure may mean ownership already moved. Inspect both sites
and the receipt before any retry. Repair through supported routing save/republish
or support; do not assume repeating the source move repairs edge state. On HTTP
428, follow dashboard reauthentication guidance; never bypass step-up. On 429,
honor the retry window rather than minting more tokens or parallelizing retries.

Compare destination routing with the saved source document. Remove upstream proxy
rules only after their replacement routes work; retain intentional external routes,
authentication links and redirects. A catchall alone does not prove external proxying.
`site routing set --file <reviewed-json>` replaces the routing document; preserve
unrelated rules. Then republish the selected destination to regenerate hostname-based
metadata. Verify TLS, both apex/WWW hosts, canonical redirect path/query preservation,
all scoped routes, and forms through the real custom domain.

If verification fails, keep the source resources. Restore traffic/routing only as
part of a coherent rollback including source configuration and data access. Account
for destination writes made since cutover before reverting to the source database.

## 7. Separately clean up and hand off

Present the final source-resource deletion list and dependencies. Use existing
explicit approval; otherwise obtain approval for that concrete list. Keep an agreed
rollback/observation period before deleting source resources. Site deletion can
remove repository backing and infrastructure; it is not merely hiding a site card.

```sh
ploy site delete "$SOURCE_SITE" --from-workspace "$SOURCE_WS" --confirm-site "$SOURCE_SITE" --json
```

Attached domains must already be moved/disconnected. CLI deletion preserves
workspace library assets and does not archive databases. Cleanup is requested,
not proven complete; report pending cleanup and seek support if it stalls.

Delete a source database only if no remaining site, job or integration uses it:
`ploy database delete "$SOURCE_DB" --from-workspace "$SOURCE_WS"
--confirm-database "$SOURCE_DB" --json`. This archives it and revokes its tokens;
it is not immediate physical erasure. Shared databases should remain in place.
Remove only known synthetic form submissions with `form delete <id>
--from-workspace <id> --site <id>`. A repeated deletion returns 404; inspect prior
receipts rather than treating all 404s as successful cleanup.

Recheck remaining source sites and shared asset URLs after site deletion. Report
source/destination IDs, deployed revision/URL, resource mappings, browser/data
verification, routing state, retained shared resources, cleanup status and gaps.

## E2E evidence when testing a PR build

Use the migration above as the test; do not substitute internal API/database edits
for a failing CLI operation. For every applicable new command, record redacted
arguments, CLI/build and server identity, exit status, receipt, and independent
result verification. Distinguish passed, failed, unsupported and not exercised.
Capture dashboard token creation as a dashboard step, not a CLI-tested capability.

Use disposable source/destination workspaces in the explicitly allowed test
organization. Record the baseline and every created resource before proceeding;
leave existing test-workspace contents untouched. Disable form mail before any
synthetic submission. After the authorized source-deletion test, verify that the
destination still reads its own database and assets. Separately verify site
deletion preserves source library assets and databases before cleaning them up.
Delete the created sites/databases with the CLI and remove disposable workspaces
through the dashboard (there is no workspace-delete CLI command). Confirm they
are absent from discovery and temporary sites no longer serve the fixture;
background garbage collection is a separate claim from logical deletion.

Safe repeat checks include asset-copy mapping stability, reusing a database
operation key, and repeating completed form-copy batches. Test destructive refusal,
forced failures, wrong-scope access and database deletion on disposable resources
only, never on customer data merely to increase test coverage. State what was not
exercised (for example source database deletion when it remains shared).

If a command fails, preserve its receipt/state, diagnose it and report any proposed
workaround. A migration finished through a workaround is not a passing E2E for
that command. Keep customer evidence private; publish only a sanitized summary.
