# Contributing to playwright-archaeologist

Thanks for your interest in contributing. This document covers local setup,
coding conventions, and how to get a change merged.

## Prerequisites

- **Node.js 20.18.0** (see `.nvmrc`). Node 22 is also supported.
- **Git** and a GitHub account.
- About **1.5 GB** of free disk for dependencies + Playwright's bundled Chromium.

## Local setup

```bash
git clone https://github.com/BFAlajid/playwright-archaeologist.git
cd playwright-archaeologist
npm ci
npx playwright install chromium
```

Verify your environment with:

```bash
npm run typecheck
npm run test:unit
npm run test:integration
```

If unit tests fail on a clean checkout, open an issue — that's a repo bug.

## Common scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Build `dist/` with tsup |
| `npm run dev` | Rebuild on file changes |
| `npm run test:unit` | Fast tests, no browser |
| `npm run test:integration` | Playwright-backed tests, requires Chromium |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint on `src/` |
| `npm run format` | Prettier write |
| `npm pack --dry-run` | Inspect what the next npm publish would ship |

## Code style

- **TypeScript strict mode** is on. Fix type errors rather than casting to `any`.
- **ESM only.** Use `import`/`export`, not `require`.
- **Prettier** formats the code. Run `npm run format` before pushing.
- **No comments that restate the code.** Comments should explain *why*, not
  *what*. Trust the reader.
- **Prefer functions over classes** unless you need shared mutable state.
- **Validate external input at the boundary.** Everything that enters from
  the network, the filesystem, or CLI args should be parsed with Zod.

## Tests

- Any new feature or bug fix needs a test.
- Unit tests go in `test/unit/` and must not spawn browsers.
- Integration tests go in `test/integration/`.
- Test behaviour, not implementation detail. Assert on the artifact a user
  would inspect — not on which private method was called.

## Pull request process

1. Fork the repo and create a feature branch off `master`.
2. Make your change with tests.
3. Run `npm run typecheck && npm run test:unit` locally. CI will do the rest.
4. Open a PR against `master`. Fill in the PR template.
5. Sign your commits (`git commit -s`). This project has **no CLA** — the
   `Signed-off-by` line is sufficient to assert the [DCO](https://developercertificate.org/).
6. A maintainer will review. Address comments by pushing new commits — do
   not force-push during review unless asked.

## Commit messages

Short, imperative, lowercase subject. One line per idea in the body.

```
fix: escape form names when rendering report

The HTML report injected form `name` attributes without escaping,
producing broken markup for forms containing angle brackets.
```

## Good first issues

If you want to contribute but aren't sure where to start, filter issues by
the [`good first issue`](https://github.com/BFAlajid/playwright-archaeologist/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
label. These are scoped small and well-described.

## Reporting security issues

Please do **not** file security problems as public issues. See
[SECURITY.md](./SECURITY.md) for the private disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Participation implies agreement.
