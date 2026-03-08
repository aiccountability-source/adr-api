"""
Example: Clinical Triage
ADR SDK — Accountability.ai

Human oversight is REQUIRED for all clinical decisions.
The human_oversight record is mandatory, not optional.

Regulatory note: clinical AI decisions are subject to FDA Software as a
Medical Device (SaMD) guidance and equivalent frameworks in other jurisdictions.

Run: python examples/clinical_triage.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="triage-support-agent-v3",
    agent_version="3.0.1",
    policy_version="ClinicalTriagePolicy-v2.1",
    jurisdiction=["CA"],
    deployment_date="2026-03-01"
)

record = client.record(
    decision_type="clinical_triage",
    input_summary={
        "patient_id": "pseudonym-PT4491",
        "age": 67,
        "presenting_complaint": "chest_pain_acute",
        "systolic_bp": 158,
        "heart_rate": 104,
        "o2_sat": 0.94,
        "ecg_finding": "st_elevation_lead_ii"
    },
    output={
        "recommendation": "fast_track_cardiac",
        "urgency": "immediate",
        "pathway": "STEMI_protocol"
    },
    reasoning=(
        "Fast-track cardiac pathway triggered at 96% confidence. "
        "ST elevation in Lead II is the primary clinical indicator: "
        "elevation of 2.1mm exceeds the 1mm STEMI diagnostic threshold. "
        "Supporting indicators: systolic BP 158mmHg elevated above 140mmHg reference, "
        "heart rate 104bpm exceeds 100bpm tachycardia threshold, "
        "O2 saturation 94% is below 95% target. "
        "Presenting complaint of acute chest pain with these findings triggers "
        "STEMI protocol under ClinicalTriagePolicy-v2.1. "
        "Risk tier: HIGH. Factors driving stratification: ST elevation, "
        "tachycardia, hypertension, and desaturation in combination. "
        "Patient age 67 is within the validated model population (18-85). "
        "Human clinical review is required before any intervention. "
        "Authorized under ClinicalTriagePolicy-v2.1."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.96,
    human_review_required=True,
    affected_party_id="pseudonym-PT4491",
    feature_attribution={
        "st_elevation_lead_ii": +0.51,
        "presenting_complaint_chest_pain": +0.24,
        "heart_rate_104": +0.13,
        "o2_sat_94": +0.08,
        "systolic_bp_158": +0.07
    },
    human_oversight={
        "required": True,
        "policy_basis": "ClinicalTriagePolicy-v2.1 Section 4.1 — all clinical AI decisions require human review",
        "reviewer_role": "attending_physician"
    }
)

record.print_summary()
print(f"Human review required: {record.human_review_required}")
print(f"Chain integrity: {'VERIFIED' if record.verify_integrity() else 'FAILED'}")

