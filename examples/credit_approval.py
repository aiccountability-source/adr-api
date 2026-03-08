"""
Example: Credit Approval
ADR SDK — Accountability.ai

Demonstrates a compliant credit decision record with Ed25519 signing.
Covers: approved decision, denied decision, and human review referral.

Run: python examples/credit_approval.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="credit-decision-agent-001",
    agent_version="2.1.0",
    policy_version="CreditPolicy-v2.3.1",
    jurisdiction=["CA"],
    deployment_date="2026-03-01"
)

# ── Approved decision ──

approved = client.record(
    decision_type="credit_approval",
    input_summary={
        "applicant_id": "pseudonym-A7X92",
        "credit_score": 712,
        "income_to_debt_ratio": 0.31,
        "employment_months": 48,
        "recent_inquiries": 2
    },
    output={
        "decision": "approved",
        "limit": 15000,
        "rate": 0.0899
    },
    reasoning=(
        "Application approved at 84% confidence. "
        "Credit score 712 exceeds minimum threshold of 680 under CreditPolicy-v2.3.1. "
        "Income-to-debt ratio of 0.31 contributed +23% toward approval. "
        "Employment stability of 48 months contributed +18% toward approval. "
        "Two recent credit inquiries contributed -8% against approval. "
        "Net positive factors outweigh negative factors by 33 percentage points. "
        "No data quality flags present. Decision authorized under CreditPolicy-v2.3.1."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.84,
    affected_party_id="pseudonym-A7X92",
    feature_attribution={
        "credit_score": +0.31,
        "income_to_debt_ratio": +0.23,
        "employment_months": +0.18,
        "recent_inquiries": -0.08
    }
)

approved.print_summary()

# ── Denied decision ──

denied = client.record(
    decision_type="credit_approval",
    input_summary={
        "applicant_id": "pseudonym-B3K11",
        "credit_score": 601,
        "income_to_debt_ratio": 0.58,
        "employment_months": 6,
        "recent_inquiries": 7
    },
    output={"decision": "denied"},
    reasoning=(
        "Application denied at 91% confidence. "
        "Credit score 601 is below minimum threshold of 680 under CreditPolicy-v2.3.1. "
        "Income-to-debt ratio of 0.58 contributed -34% against approval — "
        "exceeds maximum acceptable ratio of 0.45. "
        "Employment tenure of 6 months contributed -22% against approval — "
        "below the 12-month stability threshold. "
        "Seven recent credit inquiries contributed -19% against approval. "
        "Adverse factors: below-threshold credit score, high debt ratio, "
        "short employment tenure, elevated inquiry count. "
        "Decision authorized under CreditPolicy-v2.3.1."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.91,
    affected_party_id="pseudonym-B3K11",
    feature_attribution={
        "income_to_debt_ratio": -0.34,
        "employment_months": -0.22,
        "recent_inquiries": -0.19,
        "credit_score": -0.16
    }
)

denied.print_summary()

# ── Chain verification ──

records = [approved, denied]
chain_ok = client.verify_chain(records)
print(f"Chain integrity: {'VERIFIED' if chain_ok else 'FAILED'}")
print(f"Records generated: {client._record_count}")
