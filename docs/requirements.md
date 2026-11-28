# Requirements

Current behavior only; future work lives in GitHub issues. Each requirement is one EARS sentence, then
`[verified]` (a test or check carries `Validates: <ID>`) or `unverified:` with the reason. IDs are never
reused. Unit tests: `test/unit.test.ts`. End-to-end tests against a throwaway Immich: `e2e/flow.test.ts`
(the "smart search and OCR" block runs only with `E2E_ML=1`, in the weekly "E2E with machine learning"
workflow). Image checks: `script/image-smoke`. Release checks: the verify step of
`.github/workflows/release.yml`.

## Sign-in (OAuth 2.1)

- **IM-001** When an MCP client asks, the server shall publish the protected-resource and
  authorization-server metadata (S256 PKCE only), and shall answer an unauthenticated MCP request with 401
  and a `resource_metadata` challenge. [verified]
- **IM-002** If a client registers a redirect URI outside `ALLOWED_REDIRECT_URIS` (by default Claude's
  callbacks and loopback addresses on any port), then the server shall refuse the registration; look-alike
  hosts and schemes do not match. [verified]
- **IM-003** When a user authorizes a client, the server shall show its own sign-in page (no framing) that
  names what the app may do, check the Immich email and password with Immich, and issue a code only to the
  matching S256 PKCE verifier. [verified]
- **IM-004** The sign-in page's Content Security Policy shall let its form post to this server and its
  redirect go to the client's redirect URI, so a real browser completes the sign-in. [verified]
- **IM-005** When a code is exchanged, the server shall accept it once, only from the client it was issued
  to. [verified]
- **IM-006** When a refresh token is used, the server shall rotate it; if a refresh token is used again after
  its grace window, then the server shall end that sign-in. [verified]
- **IM-007** When a refresh token is revoked, the server shall end that sign-in. [verified]
- **IM-008** The server shall store only hashes of its tokens, and the Immich API key sealed with
  AES-256-GCM; a tampered sealed value shall fail to open. [verified]
- **IM-009** When a user signs in, the server shall create one API key in their Immich account with only the
  permissions the tools need, and replace the key of earlier sign-ins from the same app (same redirect URI).
  [verified]
- **IM-010** When a user signs in, the server shall delete their unused keys of its own name left by expired
  or failed sign-ins (sparing keys younger than `KEY_GRACE_SECONDS`), and no other keys. [verified]
- **IM-011** When the same sign-in form is submitted again, during or after the first submit, the server shall
  join the first sign-in and redirect to the same code. [verified]
- **IM-012** When the API key has been created, the server shall log out the Immich password session it
  used, and shall never store the password.
  unverified: the e2e suite does not inspect Immich's session list; checked by reading `src/immich.ts`.

## Safety

- **IM-020** The server shall never request a `*.delete` permission for its API key, so Immich itself refuses
  every delete, trash or key-management call made with it. [verified]
- **IM-021** The server shall add admin permissions to the key, and offer the `admin_*` tools, only for an
  Immich admin. [verified]
- **IM-022** The server shall offer no tool that deletes, trashes or removes anything. [verified]
- **IM-023** If Immich rejects the stored key (the user deleted it), then the tool call shall fail with a
  message to reconnect and the server shall end the sign-in, so the next request gets 401. [verified]

## Tools

- **IM-030** When `search_photos` is called, the server shall filter by date range, people, album, tags, file
  name and description, order by newest or oldest, and fail on a person name it cannot resolve. [verified]
- **IM-052** When `search_photos` gets camera, place, type, favorite or rating filters, the server shall pass
  them to Immich's metadata search.
  unverified: the e2e fixtures carry no camera data and the suite exercises only the filters in IM-030.
- **IM-031** When `search_photos` gets a plain day for `taken_after` or `taken_before`, the server shall
  match the local day where the photo was taken, not the UTC day. [verified]
- **IM-032** When `search_photos` gets a `query`, the server shall run Immich's smart (CLIP) search, so a
  photo is found by what it shows. [verified]
- **IM-033** When `search_photos` gets `text_in_photo`, the server shall match the OCR text in photos, and
  `get_photo_details` with `include_text` shall return that text. [verified]
- **IM-034** When `view_photos` is called, the server shall return the photos themselves as images: up to 4
  large or 16 small. [verified]
- **IM-035** When `get_photo_details` is called, the server shall return the date and time zone, place and
  GPS, camera, description, rating, tags and every detected face with its person. [verified]
- **IM-036** When `list_people` is called, the server shall list named people, filterable by name, with
  photo counts on request. [verified]
- **IM-037** When `list_albums` is called, the server shall list the user's albums with photo counts,
  filterable by name. [verified]
- **IM-038** When `list_tags` is called, the server shall list the user's tags. [verified]
- **IM-039** When `search_suggestions` is called, the server shall list the exact place and camera values
  Immich knows for a field. [verified]
- **IM-040** When `about_connection` is called, the server shall name the signed-in user, whether they are an
  admin, and the running server version (`immich-mcp X.Y.Z`). [verified]
- **IM-041** When `update_photos` is called, the server shall set the description, favorite, rating, date
  taken or location of one or many photos, and refuse out-of-range values. [verified]
- **IM-042** When `tag_photos` is called, the server shall add the tags to the photos, creating missing tags
  and nesting `Parent/Child` names. [verified]
- **IM-043** When `untag_photos` is called, the server shall remove the tags from the given photos only.
  [verified]
- **IM-044** When `update_person` is called, the server shall set a person's name, birth date, hidden or
  favorite flag. [verified]
- **IM-045** When `create_person` is called, the server shall create a person. [verified]
- **IM-046** When `reassign_face` is called, the server shall move the face to the given person. [verified]
- **IM-047** When `merge_people` is called, the server shall merge the given people into one. [verified]
- **IM-048** When `admin_server_overview` is called by an admin, the server shall report library totals,
  including uploaded file size. [verified]
- **IM-049** When `admin_list_users` is called by an admin, the server shall list the Immich users. [verified]
- **IM-050** When `admin_job_queues` is called by an admin, the server shall list busy queues with their
  non-zero counts, queues with only failed jobs under `failed`, and the rest as idle. [verified]
- **IM-051** When `admin_queue_control` is called by an admin, the server shall start (unprocessed items only,
  never a forced re-run), pause or resume a queue. [verified]

## Results

- **IM-060** The tools shall leave empty values, arrays and objects out of their results. [verified]
- **IM-061** The tools shall write a time as UTC when the file has no time zone, as unknown for an epoch
  date, and a video's length as m:ss or h:mm:ss. [verified]
- **IM-062** When a tool works on several photos, the server shall run at most a fixed number of Immich
  requests at once and keep the results in input order. [verified]

## Operation

- **IM-070** If Immich does not answer a tool call within `IMMICH_TIMEOUT` (default 45 s, under Claude's 60 s),
  then the call shall end with a clear error, and its Immich requests shall stop. [verified]
- **IM-071** The server shall log one line per tool call with the user, duration and outcome. [verified]
- **IM-072** If the MCP transport rejects a request, then the server shall log why, with its
  `mcp-protocol-version`. [verified]
- **IM-073** The image shall run as a non-root user, keep its data in `/data`, and answer `/healthz` on the MCP
  path with its version. [verified]

## Release

- **IM-080** When CI passes for a push to `main`, the release shall publish that commit as the next version in
  the series of `package.json` (its major.minor, patch one above the highest tag of that series), tag it
  `vX.Y.Z`, and move the image tags `X.Y.Z`, `X.Y`, `latest` and `sha-<commit>` to the tested image. [verified]
- **IM-081** Every released image shall carry a build-provenance attestation signed by
  `.github/workflows/release.yml` on `refs/heads/main` and a keyless cosign signature by the same identity,
  both present before any image tag points at it. [verified]
