# Juno Catalog Ingestion Specification

## Purpose

Define the offline creation and safe publication of the synthetic Juno catalog.

## Requirements

### Requirement ING-001: Bounded synthetic catalog

The source dataset MUST contain exactly 10 offers across at least two merchants. Every merchant MUST be in Argentina and accept Juno; every offer MUST use ARS, Spanish user-facing content, and MUST NOT include a purchase continuation URL.

#### Scenario: Accepted fixture

- GIVEN a fixture satisfying every catalog invariant
- WHEN ingestion validates it
- THEN all 10 offers are accepted as one candidate version

#### Scenario: Rejected fixture

- GIVEN a fixture with a wrong count, unsupported market or currency, non-Juno merchant, or continuation URL
- WHEN ingestion validates it
- THEN the whole candidate is rejected and nothing is published

### Requirement ING-002: Offer integrity

Each offer MUST have a stable unique `item_id`, a valid merchant reference, an integer non-negative minor-unit price, and explicit availability. Duplicate, orphaned, or invalid offers MUST reject the candidate.

#### Scenario: Invalid offer

- GIVEN one offer violates an integrity rule
- WHEN the candidate is loaded
- THEN the candidate fails without partial acceptance

### Requirement ING-003: Minimal search projection

Ingestion MUST persist exactly one search projection per offer whose searchable payload contains only `item_id`, Spanish `name`, Spanish `description`, Spanish `item_info`, and a compatible embedding. The projection and authoritative offer MUST share one version and `item_id`. Price, availability, currency, merchant details, and other hard commerce fields MUST NOT be stored in or inferred from the searchable payload.

#### Scenario: Complete derivation

- GIVEN 10 valid offers
- WHEN derivation completes
- THEN each offer has one projection with exactly the required searchable fields

#### Scenario: Commerce values stay authoritative

- GIVEN searchable text conflicts with an offer's hard commerce values
- WHEN the projection is persisted
- THEN it contains no hard fields and the authoritative offer remains unchanged

#### Scenario: Projection mismatch

- GIVEN a projection lacks a matching `item_id` in its catalog version
- WHEN the candidate is validated
- THEN publication fails for the complete candidate

#### Scenario: Derivation failure

- GIVEN any document or embedding cannot be produced
- WHEN ingestion processes the candidate
- THEN publication MUST fail for the complete candidate

### Requirement ING-004: Atomic version lifecycle

Publication MUST be atomic, expose at most one active version, keep candidates invisible, and be idempotent for the same source version. Failed loads MUST preserve the active version; a retained prior version MAY be restored atomically.

#### Scenario: Successful publication

- GIVEN a complete candidate and an active prior version
- WHEN publication commits
- THEN readers see only the complete candidate and the prior version becomes inactive

#### Scenario: Repeated load

- GIVEN an already processed source version
- WHEN ingestion repeats
- THEN no merchant, offer, or search projection is duplicated

#### Scenario: Failed load preservation

- GIVEN an active version and a candidate that fails before commit
- WHEN ingestion ends
- THEN the active version and its results remain unchanged

#### Scenario: Rollback

- GIVEN an active version and a retained prior version
- WHEN rollback succeeds
- THEN the prior version becomes the sole complete active version
