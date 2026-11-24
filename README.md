# immich-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) search, look at and
tidy up an [Immich](https://immich.app) photo library — **signed in with your normal Immich email and
password, acting only as you, and unable to delete anything.**

Run it next to Immich, put it behind the same domain (`https://photos.example.com/mcp`), and add that URL
as a custom connector in claude.ai or the Claude mobile app. Everyone in the household with an Immich
account can connect with their own login and sees only their own library.

## Why another Immich MCP?

The existing Immich MCP servers are good at exposing Immich's API. They were built for one person running
them on their own machine, with one API key pasted into a config file. That breaks down when you want to use
your photos from claude.ai or your phone, or share the server with family:

|                                         | **immich-mcp**                                                                                               | Typical Immich MCP                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Works as a claude.ai / mobile connector | Yes: built-in OAuth 2.1 (discovery, dynamic client registration, PKCE, refresh rotation)                     | Local stdio, or HTTP with no auth, or OAuth only via a separate identity provider you run |
| How you sign in                         | Your Immich email and password, on a page served by this server                                              | Paste an API key into a config file                                                       |
| Who it acts as                          | Each user as themselves; any number of users                                                                 | Whoever owns the one configured key                                                       |
| Credentials on the server               | A per-user API key it creates for itself, encrypted at rest; your password is never stored                   | A long-lived API key in a config file or environment variable                             |
| Revoking access                         | Delete the key "Claude (immich-mcp)" in Immich → Account Settings → API Keys                                 | Edit config files and restart                                                             |
| Deleting photos                         | Impossible: the key is created without any `*.delete` permission, so Immich itself refuses                   | Usually available, sometimes behind a confirm flag                                        |
| Tool design                             | 15 task-shaped tools, plus 4 for admins (one search tool with every filter, names accepted wherever ids are) | Dozens to hundreds of tools mirroring API endpoints                                       |
| Seeing photos                           | `view_photos` returns the images so the model can actually look at them                                      | Varies; often links or IDs only                                                           |
| Extra services to run                   | None (one container, SQLite)                                                                                 | Sometimes an identity provider (e.g. Pocket-ID)                                           |

Choose something else if you want the whole Immich API (uploads, album management, sharing, trash,
duplicates, galleries or PDF export) on your own desktop: [immich-photo-manager](https://github.com/drolosoft/immich-photo-manager)
and [ImmichMCP](https://github.com/barryw/ImmichMCP) cover far more of it. [mcp4immich](https://github.com/JoeRu/mcp4immich)
maps every endpoint and can sit behind your own OIDC provider. This project deliberately does less, so it is
safe to leave on the internet for the whole family.

## What it can do

**Find and see**

- `search_photos` — natural-language smart search ("kids on a beach at sunset") combined with filters for
  people, city/state/country, date range, photo/video, favorite, rating, album, tags, text in the photo (OCR),
  file name, description and camera
- `view_photos` — returns up to 4 large (~1440 px) or 16 small (~250 px) images for the model to look at
- `get_photo_details` — date and time zone, place and GPS, camera and exposure, description, rating, tags,
  every detected face with its box and person, optionally OCR text
- `list_people`, `list_albums`, `list_tags`, `search_suggestions` (exact place and camera names),
  `about_connection`

**Edit details**

- `update_photos` — description, favorite, rating, date taken, location (for one or many photos)
- `tag_photos`, `untag_photos` — tags are created as needed, nested as `Parent/Child`

**People and faces**

- `update_person` — name, birth date, hidden, favorite
- `create_person`, `reassign_face` — fix faces Immich assigned to the wrong person
- `merge_people` — combine people Immich split up

**Admins only** (offered only when the signed-in user is an Immich admin)

- `admin_server_overview`, `admin_list_users`, `admin_job_queues`
- `admin_queue_control` — start (unprocessed items only, never a forced re-run), pause, resume

**Not available, by design:** deleting or trashing anything, album changes, sharing and shared links, uploads,
server settings, user management.

## How sign-in works

1. The MCP client discovers the server through `/.well-known/oauth-protected-resource/mcp` and registers itself.
2. You see a sign-in page on your own domain that names the app asking and says what it may do.
3. Your email and password go to Immich once. The server creates an API key named "Claude (immich-mcp)" in
   your account with only the permissions the tools need, then logs that password session out.
4. The client gets an access token (1 hour) and a rotating refresh token (90 days). A refresh token used twice
   ends the sign-in. Only hashes of tokens are stored; the Immich key is encrypted with AES-256-GCM.
5. Signing in again from the same app replaces the old key, and any other unused "Claude (immich-mcp)" key
   left by an expired or failed sign-in is deleted. If Immich rejects the key (you deleted it), the
   connection ends and the app asks you to sign in again.

Redirect URIs are limited to Claude's callbacks and loopback addresses by default (`ALLOWED_REDIRECT_URIS`).

## Running it

Requires Immich v3 (tested with v3.4.2) with password login enabled.

```yaml
# next to Immich's docker-compose.yml
services:
  immich-mcp:
    image: ghcr.io/tonimelisma/immich-mcp:0.1.7 # pin a release; see Releases below
    environment:
      PUBLIC_URL: https://photos.example.com/mcp
      IMMICH_URL: http://immich_server:2283
    volumes:
      - ./immich-mcp:/data
    ports:
      - '127.0.0.1:8080:8080'
    restart: always
```

Route the MCP paths to it in your reverse proxy, everything else stays with Immich. For nginx:

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location ~ ^/\.well-known/(oauth-protected-resource|oauth-authorization-server|openid-configuration)/mcp {
    proxy_pass http://127.0.0.1:8080;
}
```

Then in claude.ai: Settings → Connectors → Add custom connector → `https://photos.example.com/mcp`.

| Variable                                | Default                         | Meaning                                                               |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `PUBLIC_URL`                            | (required)                      | Public URL of the MCP endpoint; also the OAuth issuer                 |
| `IMMICH_URL`                            | (required)                      | How this server reaches Immich                                        |
| `IMMICH_PUBLIC_URL`                     | origin of `PUBLIC_URL`          | Base for photo links in results                                       |
| `DATA_DIR`                              | `./data` (`/data` in the image) | SQLite database and generated encryption key                          |
| `ENCRYPTION_KEY`                        | generated into `DATA_DIR`       | Base64 32-byte key; set it to keep the key out of the data directory  |
| `ALLOWED_REDIRECT_URIS`                 | Claude callbacks, loopback      | Comma-separated; exact URIs or `scheme://host:*`                      |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | `3600`, `7776000`               | Seconds                                                               |
| `TRUST_PROXY`                           | `loopback`                      | Express `trust proxy`, for rate limits behind a proxy                 |
| `API_KEY_NAME`                          | `Claude (immich-mcp)`           | Name of the key created in Immich                                     |
| `IMMICH_TIMEOUT`                        | `45`                            | Seconds a tool call waits for Immich before it gives up with an error |
| `PORT`, `HOST`                          | `8080`, `0.0.0.0`               | Listen address                                                        |

The log has one line per tool call with who made it, how long it took and whether it worked, and the reason
for every request the MCP endpoint rejects (such as an unsupported `mcp-protocol-version`). `IMMICH_TIMEOUT`
stays under the 60 s Claude waits, so a busy Immich gives a clear error instead of a timeout with an unknown
outcome.

## Releases

Each release is a `vX.Y.Z` tag with a [GitHub release](https://github.com/tonimelisma/immich-mcp/releases) and
the image `ghcr.io/tonimelisma/immich-mcp` tagged `X.Y.Z`, `X.Y` and `latest`, built for amd64 and arm64 with an
SBOM and build provenance. `latest` only ever points at a release. `edge` and `sha-<commit>` follow `main`
between releases and are for testing. Pin `X.Y.Z` and upgrade when you choose, or follow the releases or the
`latest` tag with whatever you use to update containers. Changes are listed in [CHANGELOG.md](CHANGELOG.md).
Releases are built only by `.github/workflows/release.yml` on `main`, and each image carries a build-provenance
attestation, which you can require before deploying:

```sh
gh attestation verify oci://ghcr.io/tonimelisma/immich-mcp@<digest> --repo tonimelisma/immich-mcp \
  --signer-workflow tonimelisma/immich-mcp/.github/workflows/release.yml --source-ref refs/heads/main
```

`/healthz` on the MCP path (for example `https://photos.example.com/mcp/healthz`) reports the running version.

## Development

```sh
npm install
npm run check                                   # typecheck, lint, unit tests
docker compose -f e2e/docker-compose.yml up -d --wait   # throwaway Immich on 127.0.0.1:2299
npm run test:e2e                                # sign-in and every tool against it
```

The end-to-end suite never touches a real library: it creates its own admin, user, photos, people and faces in
a container whose data lives in memory.

## License

[MIT](LICENSE)
