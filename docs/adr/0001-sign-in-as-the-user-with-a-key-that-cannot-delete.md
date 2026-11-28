# 0001. Sign in as the user, with an API key that cannot delete

- Status: accepted
- Date: 2026-11-21

## Context and problem

The server is meant to be reachable from claude.ai and the Claude mobile app, and shared by everyone in a
household who has an Immich account, so it sits on the internet. Each person must act only as themselves,
and a model driving the tools must not be able to destroy a library, whatever the server's own code does.
Serves IM-003, IM-009, IM-010, IM-020, IM-021, IM-022, IM-023.

## Decision drivers

- Works as a remote MCP connector without an extra identity provider.
- Each user acts as themselves; the server never holds a password.
- Deletion is impossible even if a tool or the server has a bug.
- Revocable from Immich's own settings.

## Considered options

### One configured admin API key

- Good: simplest; what most Immich MCP servers do.
- Bad: every user acts as the key's owner; the key can delete everything; no per-user revocation.
- Failure modes: a leaked config file is full control of the library.

### OAuth through a separate identity provider (OIDC)

- Good: standard single sign-on.
- Bad: another service to run; Immich still needs a key per user with the right scope.
- Failure modes: the provider being down blocks every connector.

### Built-in OAuth 2.1 whose sign-in page checks the Immich password and mints a scoped key

- Good: no extra service; the password is used once and never stored; the key carries only the permissions
  the tools need and no `*.delete`, so Immich itself refuses deletes; the user revokes it in Immich.
- Bad: the server implements OAuth (discovery, dynamic registration, PKCE, refresh rotation) itself; needs
  Immich password login enabled.
- Failure modes: stale keys from abandoned sign-ins pile up (swept on the next sign-in, IM-010); a deleted key
  ends the connection with a reconnect message (IM-023).

## Decision

Built-in OAuth 2.1 with a per-user, per-app Immich API key created at sign-in, without any delete permission
and with admin permissions only for admins. It is the only option where deletion is refused by Immich rather
than by this server's code.

## Consequences

- No tool can delete, trash, share or upload; adding one means changing this decision, not just the code.
- Tokens are stored only as hashes and the Immich key sealed with AES-256-GCM (IM-008).
- The permission list in `src/immich.ts` is the single owner of what the key may do.

## Confirmation

- `test/unit.test.ts` "never include a delete permission" and "give admin permissions only to admins"
  (IM-020, IM-021).
- `e2e/flow.test.ts` "the stored API key cannot delete anything": Immich answers 403 to every delete with the
  real stored key (IM-020); "offers no admin or delete tools" (IM-022).

## Retirement proof

Immich offering delegated, user-consented OAuth with scoped tokens itself, proven by an e2e test that signs in
through it and is refused every delete.

## Reversal plan

Replace the sign-in page with the other provider's flow; keep the scoped-key creation. Existing users sign in
again once; their old keys are swept by IM-010.
