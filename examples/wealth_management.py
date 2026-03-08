"""
Example: Wealth Management — Suitability Recommendation
ADR SDK — Accountability.ai

Covers Reg BI standard of care and FINRA Rule 2111 suitability obligations.
Demonstrates stale data quality flag handling and counterfactual disclosure.

Run: python examples/wealth_management.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="wealth-advisor-v2.1",
    agent_version="2.1.0",
    policy_version="reg_bi_suitability_2026_v2",
    jurisdiction=["US"],
    deployment_date="2026-01-01"
)

record = client.record(
    decision_type="suitability_recommendation",
    input_summary={
        "client_id": "pseudonym-EM67",
        "portfolio_value": 2400000,
        "current_equity_pct": 72,
        "ips_target_equity_pct": 55,
        "risk_assessment_age_months": 14,
        "retirement_horizon_years": 3
    },
    output={
        "decision": "referred_for_human_review",
        "recommendation": "rebalance_deferred",
        "rebalancing_value": 408000
    },
    reasoning=(
        "Portfolio rebalancing deferred — referred for advisor review at 74% confidence. "
        "Current equity allocation 72% exceeds IPS target of 55% for clients within 5 years "
        "of retirement by 17 percentage points. Rebalancing value: $408,000. "
        "IPS equity deviation contributed +42% toward rebalancing recommendation. "
        "Retirement proximity of 3 years contributed +38% toward rebalancing recommendation. "
        "Risk tolerance assessment is 14 months old — exceeds the 12-month freshness "
        "threshold under reg_bi_suitability_2026_v2 Section 3.1. "
        "Stale assessment contributed -35% confidence cap. "
        "Reg BI standard of care requires current suitability documentation before execution. "
        "Counterfactual: if risk assessment were current (12 months or fewer), "
        "confidence would rise to 88% and rebalancing would proceed automatically. "
        "Human advisor review required before $408,000 rebalancing proceeds. "
        "Policy basis: reg_bi_suitability_2026_v2 and FINRA Rule 2111."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.74,
    human_review_required=True,
    affected_party_id="pseudonym-EM67",
    data_quality_flags=["risk_assessment_stale_14mo"],
    feature_attribution={
        "ips_equity_deviation_17pp": +0.42,
        "retirement_proximity_3yr": +0.38,
        "fixed_income_underweight": +0.31,
        "stale_risk_assessment": -0.35,
        "no_client_contact_90d": -0.28
    },
    human_oversight={
        "required": True,
        "policy_basis": "reg_bi_suitability_2026_v2 Section 3.1 — stale risk assessment triggers mandatory advisor review",
        "reviewer_role": "registered_investment_advisor"
    }
)

record.print_summary()
print(f"Chain integrity: {'VERIFIED' if record.verify_integrity() else 'FAILED'}")
