"""
Example: Insurance Underwriting — Term Life Application
ADR SDK — Accountability.ai

Covers actuarial risk assessment with converging risk factors,
stale medical records flag, and self-reported data quality gaps.

Run: python examples/insurance_underwriting.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="underwriting-engine-v3.2",
    agent_version="3.2.0",
    policy_version="life_underwriting_policy_2026_v1",
    jurisdiction=["US"],
    deployment_date="2026-01-01"
)

record = client.record(
    decision_type="export_eligibility",  # using closest available; extend enum for insurance_underwriting
    input_summary={
        "applicant_id": "pseudonym-RO52",
        "age": 52,
        "coverage_requested": 500000,
        "term_years": 20,
        "bmi": 31.4,
        "blood_pressure": "138/88",
        "smoker_status": "non-smoker (self-reported)",
        "cotinine_test_on_file": False,
        "family_history_cardiac_event_age": 61,
        "occupation": "commercial_truck_driver_DOT_class_A",
        "prior_auto_claim_years_ago": 3,
        "medical_records_age_months": 14
    },
    output={
        "decision": "referred_for_human_review",
        "preliminary_rating": "substandard",
        "estimated_premium_loading_pct": 35,
        "coverage_approved": False
    },
    reasoning=(
        "Term life underwriting deferred — referred for medical underwriter review "
        "at 0.71 confidence. Converging risk factors prevent automated approval. "
        "BMI of 31.4 (Class I obesity) contributed +0.31 toward substandard rating. "
        "Blood pressure 138/88 is borderline Stage 1 hypertension — "
        "contributed +0.28 toward substandard rating. "
        "Family history: father cardiac event at age 61 — "
        "elevated hereditary cardiac risk contributed +0.24 toward substandard rating. "
        "Occupation DOT Class A commercial truck driver: elevated mortality risk "
        "category under life_underwriting_policy_2026_v1 Schedule B — "
        "contributed +0.19 toward substandard rating. "
        "Smoker status self-reported as non-smoker; no cotinine test on file — "
        "data quality flag: unverified nicotine status contributed -0.22 confidence cap. "
        "Medical records are 14 months old — exceed 12-month freshness threshold "
        "under life_underwriting_policy_2026_v1 Section 2.4 — "
        "stale records contributed -0.18 confidence cap. "
        "Prior auto claim 3 years ago: not life-underwriting relevant, not scored. "
        "Counterfactual: if cotinine test confirmed non-smoker status and current "
        "medical records were on file, confidence would rise to 0.86 and "
        "substandard rating could proceed to automated premium loading of +35%. "
        "Human medical underwriter review required before any coverage decision. "
        "Policy basis: life_underwriting_policy_2026_v1, NAIC Model Underwriting Guidelines."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.71,
    human_review_required=True,
    affected_party_id="pseudonym-RO52",
    data_quality_flags=[
        "smoker_status_unverified_no_cotinine",
        "medical_records_stale_14mo"
    ],
    risk_classification="HIGH",
    feature_attribution={
        "bmi_31.4_class_I_obesity": +0.31,
        "blood_pressure_138_88_borderline_hypertension": +0.28,
        "family_history_cardiac_61": +0.24,
        "occupation_dot_class_a_elevated_mortality": +0.19,
        "unverified_smoker_status": -0.22,
        "stale_medical_records_14mo": -0.18
    },
    human_oversight={
        "required": True,
        "policy_basis": (
            "life_underwriting_policy_2026_v1 Section 2.4 — stale medical records "
            "and unverified nicotine status require medical underwriter sign-off "
            "before any coverage decision on substandard-rated applicant"
        ),
        "reviewer_role": "licensed_medical_underwriter",
        "minimum_review_seconds": 240
    }
)

record.print_summary()
print(f"Chain integrity: {'VERIFIED' if record.verify_integrity() else 'FAILED'}")
