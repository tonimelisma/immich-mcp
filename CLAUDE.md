# CLAUDE.md

## What this is

immich-mcp is an MCP server for an [Immich](https://immich.app) photo library: Claude (or any MCP client)
searches, looks at and edits photos, people and tags, signed in with the user's own Immich email and password
through built-in OAuth 2.1, acting only as that user and unable to delete anything. TypeScript on Node 24 (MCP
SDK, `@immich/sdk`, Express, SQLite), shipped as the multi-arch container image `ghcr.io/tonimelisma/immich-mcp`.
Architecture: [docs/architecture.md](docs/architecture.md); users' guide: [README.md](README.md).

## Working style

- When it is clear what is wanted, do it. Ask only for what only the user can do, or for a real
  product choice nobody has made yet.
- Don't end a turn with a summary announcing the next step, an offer to continue, or a list of
  decisions that block nothing: take the next step.
- Stop only when nothing can move forward without the user, or when what blocks you is
  deliberately protected (a permission, a ruleset, a secret). Then say exactly what is needed.
- Still confirm destructive or irreversible actions outside the normal flow (deleting data,
  rewriting history, changing settings); the normal flow (branch, commit, PR, merge, release) is
  not one of them.
- Live checks that edit a real library (only when asked) undo everything they changed, even when
  they fail, and confirm the undo.

## Product invariants

- Nothing can be deleted: the API key is created without any `*.delete` permission, so Immich itself refuses,
  and no tool deletes, trashes, shares or uploads.
  ([ADR 0001](docs/adr/0001-sign-in-as-the-user-with-a-key-that-cannot-delete.md))
- Each user acts only as themselves, with a per-user, per-app key; admin permissions and tools only for Immich
  admins. Passwords are never stored; tokens only as hashes; the key sealed.
  ([ADR 0001](docs/adr/0001-sign-in-as-the-user-with-a-key-that-cannot-delete.md))
- Every tool call ends before the client's 60 s limit (`IMMICH_TIMEOUT`, default 45 s) with a clear outcome.
- Tests never touch a real library: the e2e suite builds its own data in a throwaway Immich.
  ([ADR 0003](docs/adr/0003-e2e-against-a-throwaway-immich.md))
- Only `.github/workflows/release.yml`, running on CI-green `main`, tags, publishes, attests or signs; its file
  name and branch are the signer identity consumers verify.
  ([ADR 0002](docs/adr/0002-attested-release-from-ci-green-main.md))

## Engineering philosophy

- No compatibility shims. When a structure is wrong, replace it and migrate its callers in the
  same change.
- The smallest correct design. Simplicity first; measure before optimizing, never optimize on a
  hunch.
- One owner per fact, per mutation and per side effect. Two places that know the same thing will
  disagree.
- Abstractions only at real boundaries (a process, a network, a storage format, a platform), not
  in anticipation.
- Don't guess and don't fabricate: an unknown API, path, value or result is looked up, measured or
  reported as unknown.
- You own the repository. Nothing is "pre-existing" or someone else's problem, and red CI is never
  waived: it is fixed first.
- Comments and docs describe current behavior and why it is that way, never its history.

## Engineering practices

- Test first. A change in behavior starts with a test that fails without it.
- Every bug, CI failure and review finding gets a regression test, seen failing before the fix;
  quote its red output in the PR.
- The instrumentation flywheel, every increment:
  - Never guess a bug's cause. If the logs and metrics can't explain it, add the instrumentation
    first, so this occurrence or the next one is diagnosable, then fix.
  - Never guess at performance: measure, keep a baseline, optimize, and report before and after.
  - Even when nothing is blocked, review the instrumentation on every path you touched: add what
    was missing, remove what is noise.
- Tests are hermetic: temporary directories and fixtures, never the developer's real data, config
  or accounts.
- Tools are task-shaped and registered through `defineTool()` in `src/tools/context.ts`; each fix or
  feature comes with a unit test (`test/unit.test.ts`) or an e2e test (`e2e/flow.test.ts`), in the style of
  the existing code.
- Live checks through an Immich connector backed by this server, when one is available, use only the
  read-only tools (`about_connection`, `list_*`, `search_*`, `view_photos`, `get_photo_details`,
  `admin_server_overview`, `admin_list_users`, `admin_job_queues`), one call at a time; the editing tools only
  when asked. That library's data is private: keep it out of commits, tests and fixtures.
- Prettier (`.prettierrc.json`) formats code, docs and workflows alike; eslint with typescript-eslint.
- Every action in `.github/workflows/` is pinned to a commit SHA with a `# vX.Y.Z` comment, and tools in
  `run:` to an exact version.

## Commands

```sh
script/verify                     # everything CI checks without containers; run before every push
npm ci                            # install
npm run check                     # typecheck, eslint + prettier, unit tests
npm test                          # unit tests
npx vitest run --dir test -t 'name'   # one unit test
docker compose -f e2e/docker-compose.yml up -d --wait && npm run test:e2e   # e2e against a throwaway Immich
npm run format                    # prettier --write
script/image-smoke <image> [version]  # an image's runtime contract (needs Docker)
script/process-check              # requirements, Validates tags and doc links agree
script/stage start | pre-merge <PR> | post-merge <PR>
```

## Where docs live

- `docs/index.md` maps every doc. Requirements live in `docs/requirements.md`: stable IDs, one
  EARS sentence each, current behavior only, each `[verified]` by a test tagged
  `Validates: <ID>` or `unverified: <why>`. Future work lives in GitHub issues, not in docs.
- `docs/architecture.md` says how the code is built and why; `docs/adr/NNNN-title.md` records each
  decision (superseded, never deleted); `docs/lessons.md` holds rules learned and open problems,
  and is pruned when they are resolved.
- Update the docs and this file in the same PR as the code they describe.

## Increment lifecycle

1. **Start**: `script/stage start`. Anything red on main or in the last scheduled run, and any
   unanswered review comment on recent PRs, is fixed before new work. Read the open issues.
2. **Ready**: write the Definition of Ready in the PR body: the problem, requirement IDs or
   issue, acceptance criteria, what is out of scope.
3. **Test first**, then implement with the instrumentation flywheel.
4. **Verify** with the one verify command; it must be green before pushing.
5. **Docs** (requirements, architecture, ADRs, lessons, this file) in the same PR.
6. **Land**: PR, wait for `CI gate`, squash-merge, which releases (see Git, CI and PRs).
7. **Report**: after the merge, one PR comment with the Definition of Done checklist and the final
   increment report (below).

A plan that spans several increments lives in a GitHub tracking issue with a checklist, never in
a file. Never committed: per-PR report or readiness files, session state or resume files, ledgers
of merged PRs. That information belongs in the PR and its comments.

## Git, CI and PRs

- One branch per increment, cut from a fresh `origin/main`, named `feat/`, `fix/`, `docs/`,
  `chore/`, `refactor/` or `perf/` plus a short topic. Never reuse a branch after its PR merged;
  never name a branch for the tool that wrote it.
- Every change lands through a PR whose body fills `.github/pull_request_template.md`. CI checks
  the body, and that a PR titled `fix...` changes a test.
- `CI gate` is the one required check: a job that needs every other job. Wait for it
  (`script/stage pre-merge <PR>`), and fix every failure; never bypass it.
- Squash-merge as soon as `CI gate` is green, without asking: in a cloud session with
  `gh api -X PUT repos/<owner>/<repo>/pulls/<N>/merge -f merge_method=squash -f sha=<head sha>`
  (`script/stage post-merge <PR>` does this); locally with `gh pr merge --auto --squash`.
- Merging to main releases; nobody tags or publishes by hand.
- The cloud sessions' GitHub proxy refuses tag pushes, branch deletion and GraphQL: use the REST
  API (`gh api`), and leave branch deletion to GitHub's delete-on-merge and the branch-cleanup
  workflow.
- Commit messages: an imperative subject saying what changed; the body says why.
- Releases (`.github/workflows/release.yml`), the only path that tags or publishes: CI succeeding for a
  push to `main` triggers it (`workflow_run`). It checks out the commit CI tested and picks the next patch in
  the series named by `package.json`'s version (its major.minor; the patch there is ignored, keep it 0). It
  builds the image once for amd64 and arm64 with an SBOM and provenance, pushes it by digest, checks it with
  `script/image-smoke`, attests and cosign-signs that digest, then creates the `vX.Y.Z` tag and moves
  `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`, publishes a GitHub release with notes generated from the
  merged PRs, and verifies all of it like a consumer would. It refuses any ref but `refs/heads/main` and a
  commit older than the highest release; a re-run on a tagged commit finishes that release. Scheduled and PR
  runs of CI never release.
- A minor or major series starts by changing `package.json`'s version to `X.Y.0` in a PR
  (`npm version X.Y.0 --no-git-tag-version`); its merge releases `vX.Y.0`.
- CI (`.github/workflows/ci.yml`): `check` (`script/verify`), `e2e` (throwaway Immich), `image` (amd64 build +
  `script/image-smoke`), `process`, and `CI gate`; also weekly on main. `e2e-ml.yml` runs the smart-search and
  OCR suite weekly and on dispatch: dispatch it on the branch (`workflow_dispatch`, ref = the branch) for any
  change to search or OCR handling. Read a failed job's log before changing anything. Branch cleanup:
  `.github/workflows/branch-cleanup.yml`.

## Privacy review

Before every commit, read your own staged diff (`git diff --cached`) and remove anything private
about the maintainer, their family or their computers: people's names, addresses, personal email
addresses and accounts, hostnames, home-directory paths, IP addresses, tenant, client or vault
IDs, real personal documents or photos. Use neutral stand-ins in tests and examples. There is no
list of private terms to check against: judge the diff.

## Definition of Done

An increment is done when every line holds; the final report marks each ✅ or ❌ with evidence:

- [ ] Start stage clean: main CI, the last scheduled run and recent review comments were green or
      fixed first.
- [ ] Tests first; the regression test's red output before the fix is quoted.
- [ ] The verify command is green, and CI is green on the final commit.
- [ ] Traceability and doc checks (`script/process-check`, `script/pr-check`) are green.
- [ ] Docs and CLAUDE.md are updated in the same PR.
- [ ] Instrumentation reviewed on touched paths: what was added, what removed, or why it is
      adequate.
- [ ] Privacy review done on every commit's staged diff.
- [ ] Every review thread is answered or resolved.
- [ ] Merged; main CI green; the release it produced is linked.
- [ ] Clean up: only main and open PRs' branches remain on the remote; the working tree is clean.

### Final increment report

One PR comment after the merge, with these parts:

1. **Done / not done**: what the increment delivered, and anything left out.
2. **Definition of Ready**: as written, and whether it held.
3. **Requirements, ADRs and docs**: IDs added, changed or retired; ADRs; docs touched.
4. **Design decisions**: each with the alternatives considered and why they lost.
5. **Verification evidence**: commands, CI run links and durations, release link.
6. **Regression test**: name and red output before the fix (or "no bug fixed").
7. **Diagnosis**: for a bug, the root cause and how it was established.
8. **Instrumentation**: added, removed, and gaps still open.
9. **Performance**: before and after numbers, or "not touched".
10. **Privacy review**: done on every commit; anything removed.
11. **Smells**: what looked wrong but was out of scope.
12. **Follow-ups**: each filed as an issue, linked.
13. **Definition of Done**: the checklist above, each line ✅ or ❌ with evidence.
