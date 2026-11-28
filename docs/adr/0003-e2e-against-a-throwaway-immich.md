# 0003. End-to-end tests against a throwaway Immich; machine learning weekly

- Status: accepted
- Date: 2026-11-21

## Context and problem

Most of the server's behavior is what Immich does with its requests: scoped keys, the 403s that make deletion
impossible, search semantics, faces. Mocks would test our assumptions about Immich, not Immich. A real library
is private and must never be touched by tests. Smart search and OCR need Immich's machine-learning container
and about 2 GB of models. Serves IM-001..IM-051 (the e2e-verified ones), IM-032, IM-033.

## Decision drivers

- Prove behavior against the Immich version the server targets.
- Never touch a real library or account.
- Keep every PR's CI fast enough to wait for.

## Considered options

### Unit tests with a mocked Immich API

- Good: fast, no containers.
- Bad: proves nothing about Immich's permission checks or search behavior.
- Failure modes: an Immich change breaks production while tests stay green.

### A throwaway Immich in Docker on every run, machine learning on demand and weekly

- Good: real Immich, data in memory, created and discarded per run; the expensive ML suite still runs weekly.
- Bad: needs Docker; about two minutes per run; registry rate limits occasionally fail a pull.
- Failure modes: an ML regression shows up only in the weekly run or a dispatched one.

## Decision

`e2e/docker-compose.yml` starts a throwaway Immich; `e2e/flow.test.ts` creates its own admin, user, photos,
people and faces and drives sign-in and every tool through a real MCP client and a real browser. The
"smart search and OCR" block runs with `E2E_ML=1` in `e2e-ml.yml`, weekly and on dispatch.

## Consequences

- Unit tests (`test/unit.test.ts`) cover only logic that needs no Immich.
- A change to search or OCR handling dispatches `e2e-ml.yml` on its branch before merging.
- A job failing with "error from registry: retry-after" is a rate limit: re-run the failed jobs.

## Confirmation

CI's `e2e` job is part of `CI gate`; `script/stage start` lists the latest scheduled `E2E with machine learning`
run, and a red one is fixed before new work.

## Retirement proof

An Immich-provided contract test suite or test server that covers permissions and search, run in CI.

## Reversal plan

Replace the compose file with that suite; the requirement tags move with the tests.
