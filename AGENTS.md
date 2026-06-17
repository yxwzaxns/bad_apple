# Repository Guidelines

## Project Structure & Module Organization

This repository is currently empty. When adding code, use this layout:

- `src/` for application source code and reusable modules.
- `tests/` for automated tests that mirror `src/` paths.
- `assets/` for static media, sample inputs, generated frames, or other non-code files.
- `docs/` for design notes, usage docs, and contributor references.

Prefer small modules. Name files after the behavior they contain, for example `src/frame_extractor.py` or `src/render-timeline.ts`.

## Build, Test, and Development Commands

No package manager, build system, or test runner is configured yet. Add commands to the relevant manifest when tooling is introduced, such as `package.json`, `pyproject.toml`, or `Makefile`.

Recommended command names:

- `npm run dev` or `make dev` to run the project locally.
- `npm test` or `make test` to run the full test suite.
- `npm run build` or `make build` to produce distributable output.
- `npm run lint` or `make lint` to run static checks.

Keep this section updated whenever commands change.

## Coding Style & Naming Conventions

Use the dominant style of the language or framework added. Until tooling exists, follow these defaults:

- Use 2 spaces for JavaScript, TypeScript, JSON, YAML, and Markdown.
- Use 4 spaces for Python.
- Use descriptive names for modules, functions, and tests.
- Keep generated artifacts out of source directories unless they are intentionally versioned.

If formatters or linters are added, document them here.

## Testing Guidelines

Add tests for new behavior as the codebase grows. Place tests under `tests/` and mirror the source path when practical. Use names such as `test_frame_extractor.py` or `render-timeline.test.ts`.

Tests should cover core behavior, edge cases, and parsing or rendering logic likely to regress. Document fixtures in `tests/fixtures/`.

## Commit & Pull Request Guidelines

This directory has no Git history, so no project-specific commit convention exists yet. Use short, imperative messages, for example `Add frame extraction pipeline` or `Fix render timing drift`.

Pull requests should include:

- A concise summary of the change.
- The commands run to verify it.
- Screenshots or sample output for visual changes.
- Links to related issues or notes when applicable.

## Agent-Specific Instructions

Before editing, inspect the current repository state and avoid overwriting user changes. Keep changes scoped to the requested task, update this guide when project tooling appears, and prefer repository-local commands over global assumptions.
