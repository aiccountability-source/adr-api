# Changelog

All versions of the ADR SDK follow semantic versioning.
Breaking changes to the evidentiary standard or approved reasoning methods
constitute major version increments per Reasoning Capture Methodology v1.0 Section 8.

---

## [0.1.0] — 2026-03-01

Founding release. Published alongside ADR Specification v0.1 and
Reasoning Capture Methodology v1.0.

### Added
- `ADRClient` — primary interface for generating ADR records
- `ADRecord` — immutable record dataclass with hash chain and signature
- SHA-256 hash chain with genesis block per ADR Specification v0.1 Section 5.1
- Ed25519 signing (production) with HMAC-SHA256 fallback (integration testing)
- Canonical JSON serialization for deterministic hash computation
- `validate_reasoning()` — automated quality checks per Methodology v1.0 Section 6.2
  - Substantive length gate (50 words minimum; 80+ for high-risk decisions)
  - Numeric presence check
  - Feature reference check (minimum two named input features)
  - Approved reasoning method validation (hard reject on unknown methods)
  - Temporal counterfactual requirement when confidence below 80%
  - Data quality flag coverage check
  - Confidence range validation
- `strict_mode` — raises `ComplianceError` on NON_COMPLIANT records
- `verify_chain()` — verifies integrity of a sequence of records
- `verify_integrity()` — per-record tamper detection
- Decision types: credit, export control, clinical, hiring, wealth management, general
- Reasoning methods: `chain_of_thought`, `shap`, `lime`, `rule_trace`,
  `attention`, `integrated_gradients`
- `ComplianceWarning` with `NON_COMPLIANT` / `DEFICIENT` severity tiers

### Regulatory alignment
- EU AI Act Article 12 — logging and traceability
- Canadian Directive on Automated Decision-Making — audit trail
- FDA Software as a Medical Device — clinical traceability
- CFPB Adverse Action — credit reasoning disclosure
- Colorado AI Act 2026 — high-risk decision records
- Reg BI / FINRA Rule 2111 — wealth management suitability

---

## Versioning policy

Patch (0.1.x) — bug fixes, documentation corrections, threshold adjustments  
Minor (0.x.0) — new decision types, new reasoning methods, new automated checks  
Major (x.0.0) — changes to the evidentiary standard (Section 02 of Methodology)
               or changes to the approved reasoning methods (Section 05)
