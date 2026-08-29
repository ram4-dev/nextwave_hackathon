# AGENTS.md

Repository-wide engineering guidance for human and AI contributors. Prefer this file for project expectations; narrower guidance in subtrees may refine it where a local context genuinely needs different rules.

## Scope and precedence

- This file applies to the entire repository.
- Nested guidance may add or tighten rules for a subtree; it must not weaken the portable expectations here without an explicit, documented reason.
- Follow repository evidence over assumptions about product direction, stack, or tooling.

## Current repository state

- This repository is documentation-only today.
- Product direction and technology stack are undecided.
- There is no application code, package manager, test suite, formatter, linter, typechecker, build process, or CI workflow yet.
- Do not invent stack choices, directory layouts, coverage targets, or placeholder commands to fill those gaps.

## Development workflow

- Keep each change focused on one clear outcome.
- Preserve unrelated work already present in the tree (including untracked local files) unless the change explicitly owns that work.
- Match existing repository conventions for language, naming, and documentation style.
- Verify claims from repository evidence; do not treat undecided product or architecture ideas as settled requirements.
- Prefer small, reviewable edits over speculative scaffolding.

## Testing and validation

- Test behavior at the lowest useful level for the risk involved.
- Add regression coverage when fixing a defect so the same failure is caught later.
- Use integration tests at external boundaries (APIs, services, side-effecting systems).
- Reserve end-to-end tests for critical user journeys.
- When introducing test tooling, document its reproducible repository command in the same change.
- Until a test command exists, perform available manual validation and report what was checked; do not invent a placeholder command.

## Architecture

- Keep core behavior independent from delivery, transport, and infrastructure concerns.
- Define explicit contracts at boundaries between components and external systems.
- Isolate volatile or side-effecting dependencies behind those contracts.
- Validate configuration at application boundaries and fail clearly when required inputs are missing or invalid.
- Prefer incremental design; avoid premature abstractions and prescribed directory layouts before the stack and shape of the system are known.
- Make ownership of modules and interfaces clear when code lands.

## Security and configuration

- Never commit credentials, tokens, private keys, or real environment values.
- Read configuration from the environment; version-controlled examples may include only safe placeholders.
- Validate required configuration at the application boundary.
- Treat secrets and privileged operations as explicit trust boundaries; do not blur documentation-only helpers with operational side effects.

## Documentation and change hygiene

- Keep public claims honest: distinguish current repository capabilities from planned work.
- Update documentation in the same change that alters behavior, commands, contracts, or contributor expectations.
- Do not leave speculative product, integration, architecture, setup, or roadmap commitments in public docs unless they are decided and owned.
- When introducing install, format, lint, typecheck, test, or build tooling, document the exact reproducible repository commands in that same change.

## Verification and reporting

- Run real repository commands when they exist; report what was run and the outcome.
- When introducing a tool, add its reproducible command and document usage as applicable.
- When no command exists for a check, do not invent a placeholder — perform and report the available manual validation, and disclose remaining gaps.
- State clearly what was verified, what could not be verified, and why.
