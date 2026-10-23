# CI (M7)

`.github/workflows/ci.yml`, one job (`check`) on pushes to `feat/**`, pull requests and manual dispatch.

| Rule | How |
|---|---|
| Read-only | top-level `permissions: contents: read`; `actions/checkout` with `persist-credentials: false` |
| No secrets | no `secrets.*`, no `GITHUB_TOKEN` use |
| No publish / release / deploy / upload | none of those steps; no `upload-artifact`; installers are never built in CI |
| Pinned | every action pinned to a full commit SHA (tag in a comment) |
| No repo settings | the workflow does not touch branch protection or repo settings; none were changed |
| Offline tests | network only for the pinned actions and locked dependencies (`bun install --frozen-lockfile`, `bun run install:web`); no test talks to a live server (`test:live` is never run in CI) |

Steps: install (frozen) -> `bun run install:web` -> typecheck -> lint -> `bun run test` with `PA_REQUIRE_WEB_DEPS=1`
(missing vendored web deps fail instead of being skipped) -> compat + licenses -> `build:prod` -> `node scripts/scan-bundle.mjs`.

`apps/desktop/test/security/ci-policy.test.ts` enforces these rules on the workflow file itself.

Not in CI (deliberate): packaged Electron smoke (needs the Electron binary + xvfb; run locally, see release.md), the
compatibility matrix against the official new-api Docker image (needs network/pulling images; open question).
