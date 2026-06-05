# User E2E Testing

This folder defines the agent-run browser testing workflow for Instatic.

- `protocol.md` explains how an agent should run user-facing E2E audits.
- `feature-matrix.md` lists scenario rows by product area.
- `capabilities.md` expands the capability/access-control E2E rows.
- `run-log-template.md` is copied into `runs/` for each audit.
- `runs/` stores completed run logs.

## Common Requests

Use these prompts with Codex:

- "Run the Core Owner Lifecycle E2E protocol."
- "Run rows MEDIA-001 through MEDIA-003."
- "Run a friction audit of the visual builder."
- "Run the capability E2E scenarios."
- "Retest E2E-20260514-01 from the last run."
- "Promote PUB-001 into automated smoke coverage."

The project-local `instatic-user-e2e` skill should load for those requests and keep the agent focused on browser-observed user behavior.

## Automated Playwright E2E

The scripted regression suite lives outside this folder in `tests/e2e/`.
Automated E2E files use the `*.e2e.ts` suffix so `bun test` does not load
Playwright specs as unit tests.
It complements the agent-run audits above; it does not replace them. Use
Playwright for stable, critical flows where the expected result is
unambiguous, and keep exploratory UX, accessibility, and visual-friction work
in the agent-run protocol.

Run the automated suite with:

```sh
bun run test:e2e:install
bun run test:e2e
```

The Playwright config starts a disposable local stack by default:

- Admin UI: `http://127.0.0.1:5174`
- CMS/public site: `http://127.0.0.1:3002`
- Database: `.tmp/e2e-agent.db`
- Uploads: `.tmp/e2e-uploads`

`scripts/e2e-dev.ts` resets only those `.tmp/e2e-*` paths, then runs the same
Vite + Bun CMS stack a developer uses — with one deliberate difference: the CMS
runs **without** `bun --watch`. A regression suite needs a stable server, and
under watch the publish pipeline writing baked HTML (and the SQLite DB churning)
can reload the server mid-test and drop in-memory state. Vite is likewise told to
ignore the runtime-written paths (`.tmp`, `uploads`, `dist` in `vite.config.ts`),
so publishing never reloads the admin app mid-test. The Vite dev proxy follows
the configured CMS `PORT`, keeping the Playwright admin UI pointed at the
disposable CMS instead of any regular dev server on port 3001.

For debugging against a server you started yourself, set
`E2E_REUSE_SERVER=1` and override `E2E_ADMIN_BASE_URL` /
`E2E_PUBLIC_BASE_URL` as needed. Do not use reuse mode for CI or for
regression runs that need a clean database.

### Suite structure

- **`tests/e2e/helpers/`** — small, user-behaviour-shaped helpers (setup/login,
  open editor, save draft, publish-with-step-up, insert module, create page,
  visit a public page in a fresh context). No large abstractions.
- **`auth.setup.ts`** — a Playwright *setup project* that runs once. The
  disposable DB is set up once per run, so first-run setup happens here (proving
  SETUP-001) and the owner's authenticated `storageState` is saved. Every spec
  depends on it.
- **Session rule.** Specs default to the shared owner `storageState` (fast).
  Specs that **publish** (which triggers a step-up) or **sign out** rotate the
  session token server-side, so they opt into `ANONYMOUS_STATE` and `login()`
  fresh — otherwise they would invalidate the shared state for later specs.
- **Selectors.** Durable user-facing selectors first (roles, labels, accessible
  names). `data-testid` only for stable editor/canvas controls where an
  accessible name is not practical (canvas notch, toolbar publish actions, the
  step-up dialog).
- **Isolation.** With `workers: 1` all specs share one database; each spec works
  on its own uniquely-named page/post (only the core lifecycle spec edits the
  homepage), and publish→assert happens within a single test so cross-spec order
  never matters.

### Automated coverage map

These feature-matrix rows now have Playwright regression coverage:

| Row(s) | Spec |
|---|---|
| SETUP-001 | `auth.setup.ts` |
| AUTH-001, EDIT-001, SAVE-001, PUB-001, PUB-002, PUB-003 | `core-owner-lifecycle.e2e.ts` |
| CAP-003 (publish step-up only) | `core-owner-lifecycle.e2e.ts` (+ every publishing spec) |
| ADMIN-001 | `admin-navigation.e2e.ts` |
| PAGE-001, PAGE-002, PAGE-003 | `page-management.e2e.ts` |
| BUILDER-001, BUILDER-002, BUILDER-005, EDIT-002 | `visual-builder.e2e.ts` |
| MEDIA-001, MEDIA-002, MEDIA-003 | `media.e2e.ts` |
| CONTENT-001, CONTENT-002 | `content.e2e.ts` |
| SPOT-001, SPOT-002, SPOT-004, SPOT-006, SPOT-008 | `command-palette.e2e.ts` |
| ADMIN-004, CAP-001 | `users.e2e.ts` |
| ADMIN-002 (avatar) | `account.e2e.ts` |
| A11Y-001, RESP-001 | `accessibility.e2e.ts` |

### Intentionally left agent-run only

Kept in the agent-run protocol because they are subjective, drag/zoom-physics
dependent, environment-dependent, or need product/role tooling that makes a
durable assertion brittle:

- **ADMIN-003, CAP-002/004/005** — MFA setup and the finer edit-mode / data /
  media / plugin / AI capability splits. Need multi-persona role setup and
  step-up side-effect review better audited than asserted. (ADMIN-004 + the
  CAP-001 workspace-isolation core are now automated in `users.e2e.ts`.)
- **BUILDER-003/004 (DOM + canvas drag-reorder), BUILDER-006/007/008
  (styling/breakpoints/rich-text)** — drag physics and visual/typographic
  judgement; left to the friction audit. (Undo/redo, BUILDER-005, is automated.)
- **PAGE-004, CONTENT-003, MEDIA-? (none)** — unsaved-edit save-state clarity and
  collection-schema review with subjective "is this clear?" outcomes.
- **PLUGIN-001…004** — need reliable local plugin fixtures.
- **SPOT-005/007/009–013** — confirm-timeout, context ranking, reduced-motion /
  high-contrast: timing and animation/OS-mode checks unsuited to a stable
  boolean assertion.
- **SPOT-003** — **blocked by an app bug**: the viewport scope
  (`breakpointsScope.ts`) sources breakpoints via a Node-style `require()` that
  is undefined in the browser bundle, so "Switch viewport" shows *no commands*.
- **ADMIN-002 (display name/email/password)** — not yet built; ProfileTab renders
  identity read-only. Only the avatar is editable (automated above).
- **A11Y-002, RESP-002, PERF-*, REL-***  — deeper keyboard sweeps, public mobile
  layout, performance and recovery: observational, agent-run.

### Findings surfaced while automating

- **Single-page delete has no confirmation.** Deleting one page from the Site
  Explorer is immediate (only *bulk* delete and the ⌘K "Delete current page"
  command confirm). PAGE-003 asserts the mechanics; the missing confirm is a
  UX gap.
- **Command palette "Switch viewport" is dead in the browser** (see SPOT-003
  above) — a `require()` that only resolves under Node.
- **Account profile is read-only except the avatar** (see ADMIN-002 above).

The first reference spec remains `core-owner-lifecycle.e2e.ts`, the flagship
owner journey: login/logout, edit homepage text, save/reload, step-up-gated
publish, visitor-facing public output, and draft/public isolation after a later
unpublished edit.
