# Skill Registry

Generated for the SDD initialization of `nextwave` on 2026-08-29. This is an index; each listed `SKILL.md` remains the source of truth. SDD phase skills and shared references are intentionally omitted from the runtime skill index.

## Project conventions and authoritative references

- `AGENTS.md` — repository constraints, stack, testing, security, documentation, and CodeGraph ordering.
- `FLOW.md` — authoritative KYA product scope and current/planned boundary.
- `docs/SOURCES.md` — provenance for external protocols, providers, addresses, ABIs, and security claims.
- `docs/IMPLEMENTATION.md` — current architecture, states, threat boundaries, and live configuration.
- `docs/BROWSER_WALLET_MIGRATION_SPEC.md` — accepted BrowserWalletConnector migration contract.

## User skills

| Name | Scope / trigger | Source |
| --- | --- | --- |
| branch-pr | Creating or preparing GitHub pull requests with issue-first checks. | `/Users/ramiro/.agents/skills/branch-pr/SKILL.md` |
| build-on-base | Base network, RPC, contracts, deployments, and verification. | `/Users/ramiro/.agents/skills/build-on-base/SKILL.md` |
| chained-pr | PRs over 400 changed lines and review slices. | `/Users/ramiro/.agents/skills/chained-pr/SKILL.md` |
| cognitive-doc-design | Guides, RFCs, architecture, onboarding, and review-facing docs. | `/Users/ramiro/.agents/skills/cognitive-doc-design/SKILL.md` |
| didit-kyc-onboarding | Didit KYC sessions, decisions, and onboarding flows. | `/Users/ramiro/.agents/skills/didit-kyc-onboarding/SKILL.md` |
| erc-8004 | ERC-8004 agent identity, registration, reputation, and discoverability. | `/Users/ramiro/.agents/skills/erc-8004/SKILL.md` |
| find-skills | Discovering or installing skills for a requested capability. | `/Users/ramiro/.agents/skills/find-skills/SKILL.md` |
| issue-creation | Creating and triaging GitHub issues from repository evidence. | `/Users/ramiro/.agents/skills/issue-creation/SKILL.md` |
| judgment-day | Explicit blind dual review and bounded correction rounds. | `/Users/ramiro/.agents/skills/judgment-day/SKILL.md` |
| jwt-security | JWT/JWS creation, validation, expiration, and secure key handling. | `/Users/ramiro/.agents/skills/jwt-security/SKILL.md` |
| rdd-defect-workflow | Receipt-driven development, review authority, and bounded defect recovery. | `/Users/ramiro/.agents/skills/rdd-defect-workflow/SKILL.md` |
| systemic-issue-triage | Root-cause triage for new or repeated issues. | `/Users/ramiro/.agents/skills/systemic-issue-triage/SKILL.md` |
| viem-integration | EVM, viem, wallet integration, contracts, and event monitoring. | `/Users/ramiro/.agents/skills/viem-integration/SKILL.md` |
| walkthrough | Self-contained architecture and data-flow walkthrough artifacts. | `/Users/ramiro/.agents/skills/walkthrough/SKILL.md` |
| work-unit-commits | Reviewable implementation and commit slicing. | `/Users/ramiro/.agents/skills/work-unit-commits/SKILL.md` |

## Other available user skills

The following installed skills were scanned and are available when their triggers apply: `comment-writer`, `computer-use`, `gentle-ai-bench`, `go-testing`, `orca-cli`, `orchestration`, `remotion-best-practices`, `review-weekly-conversations`, `skill-creator`, `skill-improver`, `udd-review-mvp`, `compass-memory-retrieval`, `gh-stack`, `herdr-file-viewer`, `obsidian-long-term-memory`.

## Resolution notes

- For the planned frontend/API authentication work, the minimal relevant set is `didit-kyc-onboarding`, `viem-integration`, `erc-8004`, `jwt-security`, and `cognitive-doc-design`.
- External provider documentation remains authoritative over any skill guidance, as required by `AGENTS.md` and `docs/SOURCES.md`.
