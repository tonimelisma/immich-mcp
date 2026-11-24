# immich-mcp

MCP server for Immich (TypeScript, MCP SDK, `@immich/sdk`). Tools live in `src/tools/{read,write,admin,context}.ts`;
`defineTool()` in `context.ts` registers each one, types its arguments from the schema, turns errors into tool
errors and logs one line per call. Unit tests: `test/unit.test.ts`. End-to-end tests: `e2e/flow.test.ts`
against a throwaway Immich (`e2e/docker-compose.yml`).

## How work is done here

This repository builds, tests and publishes releases. Work here never deploys: no workflow reaches a
deployment. The owner's server, purkki, deploys by itself, and only images that pass:

```sh
gh attestation verify oci://ghcr.io/tonimelisma/immich-mcp@<digest> --repo tonimelisma/immich-mcp \
  --signer-workflow tonimelisma/immich-mcp/.github/workflows/release.yml --source-ref refs/heads/main
```

So releases come only from `main` through `release.yml`, which tags, publishes, attests and creates the GitHub
release with `GITHUB_TOKEN`. Every merge to `main` releases by itself, with no approval step. Never tag or
create a release by hand (cloud sessions cannot anyway), never build or attest images in another workflow or
from another branch, and never push images under semver tags any other way: purkki refuses them.

1. **Live checks, read-only**: when an Immich connector backed by this server is available, check behaviour
   with its read-only tools (`about_connection`, `list_*`, `search_*`, `view_photos`, `get_photo_details`,
   `admin_server_overview`, `admin_list_users`, `admin_job_queues`), one call at a time; a busy Immich times
   out parallel calls. Never call the editing tools (`update_photos`, `tag_photos`, `untag_photos`,
   `update_person`, `create_person`, `merge_people`, `reassign_face`, `admin_queue_control`) unless asked. A
   45 s "Immich did not answer" error is a busy Immich, not a bug. That library's data is private: keep it out
   of commits, tests and fixtures.
2. **Fix** on a branch in the style of the existing code, with a unit or e2e test for each fix. Run
   `npm ci && npm run check` locally; CI builds the image.
3. **CI**: push the branch; `ci.yml` runs check and e2e. Run "E2E with machine learning" (`e2e-ml.yml`) on the
   branch (`workflow_dispatch`, ref = the branch). Read a failed job's log before changing anything. A job
   that fails with "error from registry: retry-after" hit a registry rate limit: rerun the failed jobs.
4. **Release**: on the branch, `npm version X.Y.Z --no-git-tag-version`, add a `## X.Y.Z (date)` section to
   `CHANGELOG.md` and commit "vX.Y.Z"; then fast-forward `main` to the branch and push `main`. That merge is the
   release: `release.yml` tags `vX.Y.Z`, publishes `ghcr.io/tonimelisma/immich-mcp` as `X.Y.Z`, `X.Y` and
   `latest` with an SBOM, provenance and a build-provenance attestation, and creates the GitHub release from the
   CHANGELOG section; wait for it to go green. "Clean up branches" deletes the merged `branch/*` and `claude/*`
   branches. A push to `main` without a new version publishes only `edge` and `sha-<commit>`.
5. **Report** what was checked, fixed and released, the CI results, and the published image tags. If a
   connector is available, `about_connection` shows the version it runs (`server: immich-mcp X.Y.Z`); a
   deployment updates on its own schedule, so an older version there is not a failure.

## Notes

- The version comes from `package.json` (`npm version` also updates `package-lock.json`).
- Claude first connects with `mcp-protocol-version: 2026-07-28`, which MCP SDK 1.32.2 does not support, so
  each connection starts with a harmless 400. Upgrade `@modelcontextprotocol/sdk` once a release supports it.
- Commit messages and code carry no model names, and apart from purkki's rule above nothing names a host,
  server or environment where this runs.
