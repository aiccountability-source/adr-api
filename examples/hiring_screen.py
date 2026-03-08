"""
Example: Hiring Screen
ADR SDK — Accountability.ai

Protected class abstention is REQUIRED in every hiring screen ADR.
The statement must appear in the reasoning field itself.

Run: python examples/hiring_screen.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="hiring-screen-agent-v1",
    agent_version="1.2.0",
    policy_version="HiringPolicy-v1.1.0",
    jurisdiction=["CA"],
    deployment_date="2026-03-01"
)

# ── Candidate referred for human review (confidence below 80%) ──

referred = client.record(
    decision_type="hiring_screen",
    input_summary={
        "candidate_id": "pseudonym-C9M44",
        "role": "senior_software_engineer",
        "skills_match_score": 68,
        "skills_match_max": 100,
        "experience_years": 5,
        "required_experience_years": 5
    },
    output={"decision": "referred_for_human_review"},
    reasoning=(
        "Candidate referred for human review at 71% confidence. "
        "Skills match score 68 out of 100 against role requirements. "
        "Experience: 5 years meets the 5-year minimum requirement — contributed +15%. "
        "Technical assessment score 68 is below the 75-point interview threshold — "
        "contributed -22% against advancing. "
        "Confidence below 80% requires counterfactual disclosure: "
        "candidate would advance to interview with a technical assessment score of 75 or above. "
        "Gap of 7 points on technical assessment is the primary factor. "
        "Criteria applied: technical assessment (weight 0.45), experience (weight 0.30), "
        "skills match (weight 0.25). "
        "Protected class attributes were not used: race, gender, age, religion, "
        "national origin, disability status, or any proxy for these attributes. "
        "Authorized under HiringPolicy-v1.1.0."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.71,
    human_review_required=True,
    affected_party_id="pseudonym-C9M44",
    feature_attribution={
        "technical_assessment": -0.22,
        "experience_years": +0.15,
        "skills_match": +0.08
    }
)

referred.print_summary()

# ── Candidate advancing ──

advancing = client.record(
    decision_type="hiring_screen",
    input_summary={
        "candidate_id": "pseudonym-D2P88",
        "role": "senior_software_engineer",
        "skills_match_score": 89,
        "skills_match_max": 100,
        "experience_years": 8,
        "required_experience_years": 5
    },
    output={"decision": "advance_to_interview"},
    reasoning=(
        "Candidate advances to interview at 93% confidence. "
        "Technical assessment score 89 out of 100 — exceeds the 75-point threshold. "
        "Experience: 8 years exceeds the 5-year minimum by 3 years — contributed +28%. "
        "Skills match score 89 contributed +31% toward advancing. "
        "Candidate ranks in the top 12% of the screened pool on primary criteria. "
        "Criteria applied: technical assessment (weight 0.45), experience (weight 0.30), "
        "skills match (weight 0.25). "
        "Protected class attributes were not used: race, gender, age, religion, "
        "national origin, disability status, or any proxy for these attributes. "
        "Authorized under HiringPolicy-v1.1.0."
    ),
    reasoning_method="chain_of_thought",
    confidence=0.93,
    affected_party_id="pseudonym-D2P88",
    feature_attribution={
        "skills_match": +0.31,
        "experience_years": +0.28,
        "technical_assessment": +0.24
    }
)

advancing.print_summary()

records = [referred, advancing]
print(f"Chain integrity: {'VERIFIED' if client.verify_chain(records) else 'FAILED'}")
