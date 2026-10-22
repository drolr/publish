# AGENTS.md

> **Public snapshot:** Engineering rules retained from the project baseline. Private approval records are not included.
> **Product reference:** `docs/product/PROJECT.md`, `docs/product/FEATURES.md`, `docs/product/MVP.md`
> **Architecture reference:** `docs/architecture/TECH-STACK.md`, `docs/architecture/ARCHITECTURE.md`

This file contains only long-lived, high-cost engineering rules.

## Required Reading and Feature Workflow

- At the start of each new feature, read this file, `docs/README.md`, and `docs/process/FEATURE-WORKFLOW.md`.
- Before feature design or implementation, read `docs/product/PROJECT.md`, `docs/product/FEATURES.md`, `docs/product/MVP.md`, `docs/architecture/TECH-STACK.md`, and `docs/architecture/ARCHITECTURE.md`. Then inspect related specs, plans, source code, and tests. Use workspace documents, not Desktop copies or remembered chat summaries.
- Read `docs/process/STATUS.md` for public snapshot boundaries; verify implementation claims against existing files and test evidence. Private approval and deployment records are excluded, so public summaries must not be treated as authorization for new business or platform actions.
- Read `docs/product/PLATFORM-CORRECTION.md` and `docs/product/JUDONGCHE-PLATFORM-FACTS.md` before platform work. The approved correction supersedes conflicting ordinary-platform assumptions. The limited manual Judongche draft sample supports concrete first-platform design, not a claim that automation or the MVP is complete; business implementation still requires the new feature specification and plan approvals.
- `docs/architecture/DATA-MODEL.md` has not been supplied. Do not assume it exists or invent an approved schema. Define necessary data contracts in the relevant feature design before implementing them.
- Follow `docs/process/FEATURE-WORKFLOW.md` for intake, specification, planning, implementation, change requests, and acceptance. Historical private SOP, specifications and plans are excluded from this snapshot; follow the published workflow for new work.
- Approved feature specs define WHAT; implementation plans define HOW within the approved product scope and architecture constraints. If these conflict, report the conflict and resolve it explicitly instead of silently expanding scope.
- Save feature specs in `docs/superpowers/specs/` and plans/progress in `docs/superpowers/plans/`. Record approval evidence and update the indexes and status when the phase changes. A generated document is not automatically approved.

## Architecture Rules

- Approved MVP scope is authoritative. Do not implement P1/P2/OUT behavior without an explicit scope change.
- The approved baseline stack is Electron + React + TypeScript + Playwright + SQLite.
- Keep business/domain code independent of Electron, React, Playwright, and SQLite.
- Electron **main** is the composition root and privileged application boundary. Electron **renderer** is presentation only.
- Renderer code must access privileged capabilities only through a narrow, typed preload bridge. Renderer code must never import Electron main APIs, filesystem APIs, database APIs, or Playwright.
- Platform behavior must live behind a platform adapter. Raw selectors, page locators, platform URLs, and page-state recognition must not leak into UI or domain/application code.
- MVP targets one verified dealer-backend adapter. Judongche (巨懂车) is the first platform under design; Tengyitong (腾易通) and Icheshang (i车商) are future targets only. Do not implement the latter adapters, a plugin framework, or a generic multi-platform configuration system now.
- `src/infrastructure/platforms/dongchedi/` is an existing historical placeholder, not an implemented adapter. A future `judongche` boundary must follow verified merchant-backend semantics and its approved specification; never rename strings or reuse ordinary Dongchedi page assumptions as a substitute for that work.
- `Article Package` is the canonical external content contract. Platform-specific fields are translated at the adapter boundary.
- Local original/repost metadata does not prove a corresponding platform field exists. Cover preconditions, declaration mapping, page recognition, and success evidence must follow the Platform Facts and approved first-platform specification; unverified behavior remains `UNKNOWN / NEEDS VERIFICATION`.
- Canonical execution state lives in the application/domain layer and persistence, never in renderer component state.
- Batch execution is sequential per platform for MVP. Do not introduce parallel article submission to a dealer backend without a new architecture decision.
- On unknown or safety-sensitive platform state, fail closed: pause the platform workflow rather than guessing or continuing.
- A user stop request must prevent new tasks from starting and must take effect at the next safe automation checkpoint.
- Remote platform content must run only in the Playwright-controlled browser, not inside a privileged Electron renderer.

## Dependency Rules

- Dependency direction: `renderer -> typed bridge -> application -> domain ports <- infrastructure adapters`.
- `domain` may import only language/runtime-neutral project code and contract types. It must not import Electron, React, Playwright, SQLite drivers, filesystem, or UI packages.
- `application` may depend on domain contracts/ports, but not on concrete platform selectors, SQL, or renderer components.
- `infrastructure` implements ports for SQLite, local assets, Playwright, logging, and the approved dealer-backend adapter.
- Prefer runtime/platform capabilities before adding dependencies.
- One primary library per concern. Do not add competing state managers, schema validators, UI kits, database layers, or browser automation libraries.
- Runtime boundary validation must use one schema-validation mechanism; do not duplicate validation rules in multiple layers.
- Use the package lockfile. Upgrades affecting Electron, Playwright, SQLite access, packaging, or migrations require regression verification.
- Do not add a generic DI container. Use explicit composition in the Electron main process unless complexity proves otherwise.

## Database Rules

- SQLite is the approved persistence engine for MVP.
- SQL and SQLite driver APIs are infrastructure-only.
- Domain/application code accesses persistence through repository/unit-of-work style ports.
- Every schema change requires a numbered, reproducible migration committed to the repository.
- Migrations must be forward-only for released builds; destructive rewrites require an explicit migration/backup plan.
- Do not put workflow/business rules in triggers or stored procedures.
- Task identity and persisted state must support duplicate-execution protection across application restarts.
- A task found in an ambiguous in-flight state after an abnormal shutdown must not be automatically replayed as if it were safe.
- Passwords, verification codes, cookies, session tokens, or browser credentials must never be stored in business tables.
- Browser profile/session data is local filesystem state managed separately from SQLite.
- Article image binaries belong in the app-managed asset store; SQLite stores metadata and stable relative references rather than image BLOBs.

## UI / Design System Rules

- UI targets non-technical operators and must use business language, not implementation terminology.
- The renderer must not expose stack traces, selectors, IPC names, HTTP status codes, or raw automation exceptions as the primary user message.
- Batch start requires a human-readable summary; execution requires visible per-article state.
- Safety-sensitive UI must distinguish: article failed, human action required, platform paused, and user-stopped.
- Manual article input remains deliberately minimal: title, basic ordered body/image structure, and original/repost declaration. Do not grow it into a CMS, asset library, or publishing studio.
- Use a single app-owned design-token/component layer. Do not mix multiple UI systems for equivalent controls.
- Critical interactive elements require accessible names/roles so they are usable and testable.
- Business execution state must not be held only in React local state; renderer state is a projection of application state.

## Testing Rules

- Domain state transitions, validation, duplicate protection, cancellation, and error classification require deterministic unit tests.
- `ArticlePackageV1` requires contract fixtures for valid, invalid, and backward-compatibility cases.
- Platform adapters require controlled fixture/mock-page tests for page recognition, selectors, and failure classification.
- Test failure paths: login expired, verification required, page changed, image unavailable, user stop, app restart during task, and ambiguous draft-save result.
- Renderer tests cover the operator-critical path without using real dealer backends.
- CI must never create real platform drafts, publish real content, or use production platform sessions.
- Live dealer-backend smoke tests are manual/opt-in only and must use owner-approved test content, account, store, and operation scope. A completed probe does not authorize further live writes.
- Platform selector changes require a fixture/regression test demonstrating the changed assumption.
- Database migrations require upgrade tests from the previous supported schema.
- Production packaging must pass a smoke build before release.

## Security Rules

- Electron renderer: `nodeIntegration=false`, `contextIsolation=true`, sandbox enabled.
- Expose only specific preload methods; never expose raw `ipcRenderer`, filesystem, process, shell, or arbitrary channel sending.
- Validate IPC sender/origin and runtime payload schema at privileged boundaries.
- Do not disable `webSecurity`, sandboxing, or context isolation to simplify implementation.
- Do not load Judongche or other remote platform pages inside the operator renderer.
- Do not use the operator's default Chrome/Edge profile. Use an app-managed Playwright persistent profile dedicated to the platform session.
- Never implement CAPTCHA solving, stealth/anti-detection, identity-verification bypass, device-fingerprint spoofing, or platform safety-control circumvention.
- Never request, log, commit, export, or store platform passwords/verification codes.
- Logs/diagnostics must redact cookies, session tokens, authorization headers, credentials, and sensitive local paths where practical.
- Diagnostics stay local unless the user explicitly exports them.
- Access only pages and data needed for the authorized article/draft task. Do not inspect or collect unrelated customer leads, contacts, sales, finance, inventory, or other merchant data merely because the account can access it.
- On verification/security warnings or unknown platform state, stop the affected platform workflow.

## Quality Gates

Required before merge:

1. formatting;
2. lint/static analysis;
3. TypeScript strict typecheck;
4. unit tests;
5. Article Package contract tests;
6. adapter fixture tests;
7. migration tests when schema changes;
8. security/dependency audit supported by the ecosystem;
9. production build/package smoke check for the supported target.

Mechanically enforce, not merely document:

- forbidden dependency directions/imports;
- Electron security window preferences;
- typed/allow-listed IPC surface;
- Playwright runtime imports only in `src/infrastructure/automation/` and the exact `src/infrastructure/platforms/judongche/` subtree; no production imports of `@playwright/test` and no raw browser type reexports into other layers;
- no direct SQL/SQLite imports outside persistence infrastructure;
- formatting/lint/typecheck/tests;
- migration ordering/consistency;
- no real-platform CI actions or credentials;
- packaged build success.

## Agent Behavior

- Read approved product and architecture documents before implementation changes.
- Do not turn future needs into present dependencies. Follow P0/P1/P2/OUT and YAGNI.
- Before adding or replacing a framework, runtime, database layer, UI system, state manager, automation library, or privileged IPC capability, surface the decision.
- Do not weaken security/fail-closed behavior to make automation continue or tests pass.
- When platform behavior is ambiguous, preserve sanitized evidence where allowed, classify the state as human-required/paused, and report the uncertainty.
- Prefer the smallest change that satisfies the approved feature and preserves module boundaries.
- The architecture baseline is already approved. Platform correction does not revoke that approval or automatically approve a new adapter: proceed with document correction and concrete design, then implement only within the approved new feature specification and plan. Do not resume F02-B or other paused business work implicitly.
