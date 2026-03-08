# ADR SDK — Agent Decision Record

[![CI](https://github.com/accountability-ai/adr-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/accountability-ai/adr-sdk/actions/workflows/ci.yml)
[![License: CC BY 4.0](https://img.shields.io/badge/License-CC_BY_4.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)
[![Python 3.8+](https://img.shields.io/badge/python-3.8+-blue.svg)](https://www.python.org/)

**Accountability.ai** | [accountability.ai](https://accountability.ai)  
Version 0.1 | CC-BY 4.0  
ISBN 978-1-7389042-0-4 / 978-1-7389042-1-1

---

A bolt-on Python SDK for generating tamper-evident, cryptographically verifiable Agent Decision Records. Compliant with the [ADR Specification v0.1](https://accountability.ai/adr-spec-v0.1) and [Reasoning Capture Methodology v1.0](https://accountability.ai/reasoning-methodology-v1.0).

Three lines to initialize. One call to generate. One call to verify.

No external dependencies in demo mode. Drop `adr_sdk.py` into any Python project.

---

## Install

```bash
# No package manager required
cp adr_sdk.py your_project/

# Or install directly from GitHub
pip install git+https://github.com/accountability-ai/adr-sdk.git

# Ed25519 signing for production
pip install cryptography
```

Python 3.8 or higher required.

---

## Quickstart

```python
from adr_sdk import ADRClient

client = ADRClient(
    agent_id="your-agent-id",
    agent_version="1.0.0",
    policy_version="YourPolicy-v1.0",
    jurisdiction=["CA"]
)

# Call at inference time — not after the decision has been produced
record = client.record(
    decision_type="credit_approval",
    input_summary={"applicant_id": "pseudonym-A7X92", "score": 712},
    output={"decision": "approved", "limit": 15000},
    reasoning=(
        "Approved at 84% confidence. Credit score 712 exceeds minimum "
        "threshold of 680. Income-to-debt ratio contributed +23% toward "
        "approval. Employment stability contributed +18%. Recent inquiries "
        "contributed -8%. Authorized under CreditPolicy-v2.3.1."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.84
)

print(record.is_valid())         # True
print(record.adr_id)             # UUID
print(record.to_json())          # Full record as JSON
print(record.verify_integrity()) # True if unaltered
```

---

## The Reasoning Field

The reasoning field is the primary evidentiary field. Every record is only as good as the reasoning it contains. A hash-chained log of inadequate reasoning is still inadequate reasoning.

Compliant reasoning is:

- **Contemporaneous** — captured at inference time, in the same call as the decision output
- **Specific** — tied to this decision, not to decisions of this type in general
- **Verifiable** — contains at least one quantitative reference traceable to model outputs

Reasoning that would apply equally to any decision of the same type does not meet the evidentiary standard, regardless of technical conformance with the ADR Specification.

---

## Hash Chain

Every record contains the SHA-256 hash of its predecessor. Alteration of any record in the chain is detectable immediately. This is tamper evidence, not tamper prevention.

Each agent chain starts with a genesis block:

```
SHA256("ADR-GENESIS-{agent_id}-{deployment_date}")
```

---

## Compliance Validation

Validation runs automatically on every `record()` call. The SDK checks for:

- Reasoning minimum 50 words (80+ recommended for high-risk decisions)
- At least one numeric reference
- At least two named input features
- Approved reasoning method (unknown methods are rejected immediately)
- Counterfactual threshold when confidence is below 80%
- Data quality flags addressed in reasoning when present
- Confidence within range 0.0 to 1.0

```python
# Inspect warnings
for warning in record.compliance_warnings:
    print(warning)

# Strict mode — raises ComplianceError on NON_COMPLIANT records
client = ADRClient(
    agent_id="your-agent",
    agent_version="1.0.0",
    strict_mode=True
)
```

---

## Chain Verification

```python
records = [r1, r2, r3]
is_valid = client.verify_chain(records)
print(is_valid)  # True if chain is unbroken and all records are unaltered
```

---

## Production Signing

Demo mode uses HMAC-SHA256. For production, use Ed25519:

```python
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

private_key = Ed25519PrivateKey.generate()
# Generate once. Store securely. Do not regenerate per session.

client = ADRClient(
    agent_id="your-agent",
    agent_version="1.0.0",
    signing_key=private_key
)
```

---

## Decision Types

```python
# Credit
"credit_approval" | "credit_limit" | "rate_determination"

# Export Control
"export_eligibility" | "sanctions_screen" | "jurisdiction_check"

# Clinical
"clinical_triage" | "care_pathway" | "diagnostic_support"

# Hiring
"hiring_screen" | "candidate_ranking" | "background_assessment"

# Wealth Management
"wealth_management" | "suitability_recommendation" |
"portfolio_rebalancing" | "investment_recommendation"

# General
"content_moderation" | "fraud_detection" | "null_decision"
```

---

## Approved Reasoning Methods

| Method | Use Case |
|---|---|
| `chain_of_thought` | Preferred for LLM-based systems |
| `shap` | Preferred for tabular and gradient boosted models |
| `lime` | Acceptable when SHAP is computationally infeasible |
| `rule_trace` | Highest specificity — preferred for regulatory examination |
| `attention` | Supplementary evidence only — not sufficient standalone |
| `integrated_gradients` | Deep learning fallback |

---

## Minimum Reasoning Standards by Decision Type

These are floors, not ceilings. Implementations are encouraged to exceed them.

### Credit (credit_approval / credit_limit / rate_determination)
- Decision outcome and confidence percentage
- At least three input features with direction and weight
- Threshold disclosure when confidence is below 80%
- Adverse factors with quantitative impact for denied decisions
- Policy version

### Hiring (hiring_screen / candidate_ranking)
- Screening outcome and confidence
- All criteria applied, with weights and candidate performance against each
- Protected class abstention statement — required in every hiring ADR
- Comparative context when outcome is decline
- Human review trigger basis

### Clinical (clinical_triage / care_pathway / diagnostic_support)
- Clinical recommendation, pathway, and urgency classification
- Clinical parameters used, their values, and reference ranges
- Risk tier and stratification factors
- Model limitations when patient profile is outside the validated population
- Human review — REQUIRED, not optional

### Export Control (export_eligibility / sanctions_screen)
- Match status, match confidence, and databases screened
- Entity resolution criteria and field matches when a potential match is identified
- Jurisdiction restrictions and basis for each
- Screening parameters: fuzzy match threshold, watchlist date
- Human review trigger condition

---

## Regulatory Alignment

| Regulation | Coverage |
|---|---|
| EU AI Act Article 12 | Logging and traceability |
| Canadian Directive on Automated Decision-Making | Audit trail |
| FDA Software as a Medical Device (SaMD) | Clinical traceability |
| CFPB Adverse Action | Credit reasoning disclosure |
| Colorado AI Act 2026 | High-risk decision records |
| Reg BI / FINRA Rule 2111 | Wealth management suitability |

---

## Examples

```
examples/
  credit_approval.py      Approved and denied credit decisions
  hiring_screen.py        Referred and advancing candidates
  clinical_triage.py      Fast-track cardiac pathway with human oversight
  wealth_management.py    Suitability referral with stale data quality flag
```

---

## Tests

```bash
pip install pytest cryptography
python -m pytest tests/ -v
```

---

## Files

```
adr_sdk.py              Core SDK — drop into any Python project
README.md               This file
LICENSE                 CC-BY 4.0
CITATION.cff            Machine-readable citation (ISBN + specifications)
CHANGELOG.md            Version history
examples/               Working examples by decision type
tests/                  Automated test suite
.github/workflows/      CI — runs on every push and pull request
```

---

## Cite This Work

GitHub renders the CITATION.cff file as a **Cite this repository** button on the repository page.

Manual citation:

> ADR SDK v0.1, Accountability.ai, 2026, accountability.ai

Companion specifications:

- ADR Specification v0.1 — ISBN 978-1-7389042-0-4 — [accountability.ai/adr-spec-v0.1](https://accountability.ai/adr-spec-v0.1)
- Reasoning Capture Methodology v1.0 — ISBN 978-1-7389042-1-1 — [accountability.ai/reasoning-methodology-v1.0](https://accountability.ai/reasoning-methodology-v1.0)

Both specifications are deposited with Library and Archives Canada and the Internet Archive with ARK persistent identifiers.

---

## Specifications

- [ADR Specification v0.1](https://accountability.ai/adr-spec-v0.1)
- [Reasoning Capture Methodology v1.0](https://accountability.ai/reasoning-methodology-v1.0)
- [Internet Archive — ADR Specification](https://archive.org/details/adr-spec-v0.1)
- [Internet Archive — Reasoning Methodology](https://archive.org/details/reasoning-methodology-v1.0)

---

## Contact

spec@accountability.ai — specification questions and comments  
founding@accountability.ai — partnership and licensing  
[accountability.ai](https://accountability.ai)

CC-BY 4.0 — Free to use, adopt, and build on. Attribution required.
