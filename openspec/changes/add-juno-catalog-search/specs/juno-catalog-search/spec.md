# Juno Catalog Search Specification

## Purpose

Define public Spanish discovery over the active catalog.

## Requirements

### Requirement SEARCH-001: Public search contract

The catalog MUST expose only `POST /v1/catalog/search`. A strict request MUST contain a trimmed Spanish `query` of 2–200 characters. It MAY include integer `top_k` 1–50 (default 10), at most 50 merchant IDs, 20 categories, non-negative ordered ARS bounds, and availability (default in-stock). Unknown fields MUST fail. Search MUST NOT require auth/KYC or access KYA state.

#### Scenario: Public valid request

- GIVEN a valid request without credentials
- WHEN it is received
- THEN search proceeds without `401` or `403`

#### Scenario: Invalid request

- GIVEN malformed JSON, invalid fields, bounds, or query
- WHEN validation runs
- THEN `400 INVALID_SEARCH_REQUEST` is returned without searching

### Requirement SEARCH-002: Ordered bulk hydration

Retrieval MUST produce ranked `item_id`s with relevance, then hydrate all selected IDs once from one active catalog version. Hydration MUST preserve order and source merchant, ARS price, currency, availability, and all other hard fields only from the authoritative catalog. Per-result hydration MUST NOT occur; projections MUST NOT override hard fields. Responses MUST include version and freshness and omit embeddings and continuation URLs.

#### Scenario: Authoritative values override projection text

- GIVEN projection text conflicts with authoritative hard fields
- WHEN hydration runs
- THEN results use authoritative values in candidate order

#### Scenario: One bulk hydration

- GIVEN multiple candidate IDs
- WHEN hydration runs
- THEN all selected IDs are requested together exactly once

#### Scenario: Hydration integrity failure

- GIVEN a candidate is absent or version-mismatched
- WHEN hydration runs
- THEN `503 SEARCH_UNAVAILABLE` is returned with no partial results

#### Scenario: No matches

- GIVEN a valid query has no candidates
- WHEN search completes
- THEN `200` is returned with an empty list

#### Scenario: No active catalog

- GIVEN no active version exists
- WHEN search starts
- THEN `503 CATALOG_UNAVAILABLE` is returned

### Requirement SEARCH-003: Hybrid filtered candidates

Discovery MUST hybrid-rank `item_id`s and MAY over-fetch. After bulk hydration, exact filters MUST use authoritative fields; final selection MUST preserve rank and return at most `top_k`. No result MAY violate filters. Spanish semantic matches MAY rank without exact tokens.

#### Scenario: Semantic discovery

- GIVEN an offer conceptually matches `papas fritas` without exact tokens
- WHEN ranking runs
- THEN the offer can rank through semantic relevance

#### Scenario: Exact filters

- GIVEN ranked IDs include filter violations
- WHEN bulk hydration filters and final-selects
- THEN results obey filters and preserve rank up to `top_k`

### Requirement SEARCH-004: HNSW with exact fallback

Semantic retrieval MUST use HNSW primarily and report `search_mode: "hnsw"`. Recognized HNSW failure MUST trigger exact retrieval with identical filters and hybrid ranking, reporting `search_mode: "exact_fallback"`.

#### Scenario: Primary path

- GIVEN HNSW is available
- WHEN search runs
- THEN HNSW serves retrieval with mode `hnsw`

#### Scenario: Explicit degradation

- GIVEN HNSW has a recognized failure
- WHEN search runs
- THEN exact retrieval succeeds with mode `exact_fallback`

#### Scenario: Both paths fail

- GIVEN HNSW and exact retrieval both fail
- WHEN search cannot complete
- THEN it returns `503 SEARCH_UNAVAILABLE`

### Requirement SEARCH-005: Embedding failure

Query vectorization MUST match the active version. Failure MUST return `503 EMBEDDING_UNAVAILABLE` without partial results.

#### Scenario: Query vectorization failure

- GIVEN a valid query cannot be vectorized
- WHEN retrieval is prepared
- THEN no retrieval runs and `503 EMBEDDING_UNAVAILABLE` is returned

### Requirement SEARCH-006: Side-effect-free scope

Search MUST NOT call real Juno, create orders, reserve stock, or pay. Unexpected failures MUST return `500 INTERNAL_ERROR` without internal details.

#### Scenario: Search has no commerce side effects

- GIVEN any search outcome
- WHEN processing ends
- THEN no Juno or commerce operation occurred

#### Scenario: Unexpected failure

- GIVEN an unexpected non-index failure
- WHEN the endpoint maps it
- THEN `500 INTERNAL_ERROR` is returned without internal details
