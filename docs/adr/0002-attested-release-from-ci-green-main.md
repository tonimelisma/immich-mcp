# 0002. Attested, signed release from CI-green main

- Status: accepted
- Date: 2026-11-28

## Context and problem

Hosts install new images by themselves and must be able to tell an image this repository's release built from
anything else pushed to the registry. Releases used to need a manual `npm version` bump and a fast-forward
push; a forgotten bump meant no release, and an image could be published before CI on the same commit
finished. Serves IM-080, IM-081.

## Decision drivers

- Only a commit that passed CI on `main` is released; nobody tags or publishes by hand.
- A consumer can verify an image's origin with standard tools, by a stable signer identity.
- No tag points at an image before it is checked, attested and signed.
- No manual version bump per release.

## Considered options

### Release on push to main when package.json carries an untagged version

- Good: explicit versions, changelog written per release.
- Bad: a manual bump per release; runs in parallel with CI, so an image can ship from a red commit.
- Failure modes: a forgotten bump publishes nothing; a red commit can be released.

### Release from the CI workflow itself (`needs:`)

- Good: one workflow, one run.
- Bad: the signer identity would become `ci.yml`, which hosts do not trust today; changing it needs every
  verifying host updated at once.
- Failure modes: a host that still checks `release.yml` refuses every new image.

### `release.yml` on `workflow_run` of a successful CI push to main, version series from package.json

- Good: keeps the signer identity (`.github/workflows/release.yml` on `refs/heads/main`) hosts already check;
  runs only after CI passed; the patch is automatic, a series starts by editing one line.
- Bad: two workflow runs per merge; the image is built again after CI's amd64 check build.
- Failure modes: CI runs for consecutive merges finishing out of order (the workflow refuses an older commit);
  a failed run is re-run and finishes the release its tag already claims.

## Decision

`release.yml` triggered by `workflow_run` of CI, for successful pushes to `main` only. It builds once for both
platforms, pushes by digest, checks the image (`script/image-smoke`), attests and cosign-signs the digest, and
only then creates the `vX.Y.Z` tag and moves `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>`. The version is the
next patch in package.json's major.minor series.

## Consequences

- package.json's version names only the series; the release stamps the full version into the image.
- Release notes are generated from the merged PRs.
- `release.yml` keeps its name and runs only on `refs/heads/main`: hosts verify that identity.

## Confirmation

The release's last step (tagged `Validates: IM-080`, `IM-081`) checks that the tag points at the tested commit,
that every image tag resolves to the checked digest, and verifies the attestation and the cosign signature by
`release.yml` on `refs/heads/main`. A failure there fails the release.

## Retirement proof

Every verifying host accepting a different signer identity, shown by a host-side verification of an image signed
by the new one.

## Reversal plan

Restore the push trigger and manual bump from git history; no host change is needed because the identity stays.
