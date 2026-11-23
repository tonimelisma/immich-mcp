# Changelog

## 0.1.6 (2026-11-23)

- Release images: `latest` now moves only with a release (`X.Y.Z`, `X.Y` and `latest`), never with an unreleased
  push to `main`, which publishes `edge` and `sha-<commit>` instead. Images carry an SBOM and build provenance,
  and each release gets a GitHub release with its changelog.

## 0.1.5 (2026-11-22)

- `about_connection` reports the running server version (`server: immich-mcp X.Y.Z`), so an install can be
  confirmed through the connector.

## 0.1.4 (2026-11-22)

- `search_photos`: a plain `taken_after`/`taken_before` day is the local day where the photo was taken, as
  results show it, not the UTC day. Immich filters in UTC, so the window is widened by 14 h on each side and
  photos outside the local days are dropped; a page can therefore hold fewer than `limit` photos.
- `search_photos`: no `count` (it was only the page size and read like a total); videos show their length.
- `admin_job_queues`: queues with only failed jobs are listed under `failed`, not `busy`.
- Releases: a new version in `package.json` on `main` is tagged `vX.Y.Z` and published as image `X.Y.Z` by
  the Image workflow.

## 0.1.3 (2026-11-21)

- Every tool call has an Immich deadline (`IMMICH_TIMEOUT`, default 45 s, under Claude's 60 s), and its
  Immich requests stop when the client hangs up.
- One log line per tool call (user, duration, outcome); requests the MCP transport rejects are logged with
  their `mcp-protocol-version`.
- Dates say "UTC" when the file has no time zone and "unknown" for epoch dates; video duration as m:ss;
  focal length rounded.
- Faces as `person` plus `person_id`; `type` is "photo" or "video", as `search_photos` takes it.
- `list_people`: `total` only with `include_unnamed`; `has_more` fixed.
- `admin_server_overview`: `uploaded_files`, with a note that Immich does not count external libraries.
- `admin_job_queues`: busy queues with non-zero counts, the rest as idle.

## 0.1.2 (2026-11-21)

- After each sign-in, unused API keys left by expired or failed sign-ins are deleted (keys younger than
  `KEY_GRACE_SECONDS`, default 120, are spared unless replaced).

## 0.1.1 (2026-11-21)

- Fix sign-in hanging after "Sign in and allow": the sign-in page's CSP `form-action` now allows the
  redirect URI's origin. The page shows progress, a repeated submit joins the sign-in in flight, and earlier
  keys are replaced per user and app.

## 0.1.0 (2026-11-21)

- First release: OAuth sign-in with the Immich email and password, a per-user API key without any delete
  permission, tools to search, view and edit photos, tags, people and faces, and admin tools.
