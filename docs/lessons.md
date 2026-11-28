# Lessons

Bounded: rules learned the hard way that are not obvious from the code, and problems still open. An entry is
deleted when its problem is solved or its rule moves into a test, an ADR or `CLAUDE.md`.

## Rules learned

- A busy Immich (face detection, smart search jobs) times out parallel calls: live checks through a connector
  run one call at a time, and a 45 s "Immich did not answer" error is a busy Immich, not a bug.
- Immich filters dates in UTC while people read the local day where a photo was taken: `search_photos` widens
  the window by 14 h on each side and drops photos outside the local days, so a page can hold fewer than
  `limit` photos (IM-031).
- The sign-in page's CSP `form-action` must allow the redirect URI's origin, or the browser silently stops after
  "Sign in and allow"; only a real-browser test caught it (IM-004).
- Two simultaneous sign-ins could delete each other's new key: keys younger than `KEY_GRACE_SECONDS` are never
  swept unless replaced (IM-010).
- A CI job failing with "error from registry: retry-after" hit a registry rate limit: re-run the failed jobs
  before changing anything.

## Open problems

- Claude first connects with `mcp-protocol-version: 2026-07-28`, which `@modelcontextprotocol/sdk` 1.32.2 does
  not support, so each connection starts with a harmless 400 (logged by IM-072). Upgrade the SDK once a release
  supports it.
