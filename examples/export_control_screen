"""
Example: Export Control Screening — Dual-Use Goods
ADR SDK — Accountability.ai

Covers US Export Administration Regulations (EAR) and ITAR obligations.
Demonstrates high-confidence denial with OFAC/Entity List matching,
re-export pathway flagging, and ECCN classification.

Matches the hero scenario shown on accountability.ai.

Run: python examples/export_control_screen.py
"""

from adr_sdk import ADRClient

client = ADRClient(
    agent_id="export-screen-v4",
    agent_version="4.0.1",
    policy_version="export_policy_2026_v3",
    jurisdiction=["US_EAR", "US_ITAR", "US_OFAC"],
    deployment_date="2026-01-01"
)

# ── Record 1: High-confidence Entity List denial ─────────────────────────────

record = client.record(
    decision_type="export_eligibility",
    input_summary={
        "entity_name": "Nexus Precision Components Ltd",
        "entity_country": "UAE",
        "end_destination_declared": "UAE",
        "product_description": "CNC milling equipment, 5-axis, sub-micron tolerance",
        "eccn_classification": "2B001",
        "license_exception_claimed": "EAR99",
        "end_user_certificate_on_file": False,
        "prior_transactions": 0
    },
    output={
        "decision": "DENIED",
        "denial_basis": "Entity List proximate match — export prohibited without BIS license",
        "entity_list_match_score": 0.94,
        "license_exception_valid": False
    },
    reasoning=(
        "Export eligibility DENIED at 0.94 confidence. "
        "Entity 'Nexus Precision Components Ltd' returns proximate match of 0.94 against "
        "BIS Entity List — threshold for automatic denial is 0.85. "
        "ECCN 2B001 (precision CNC milling equipment) is a controlled dual-use item "
        "requiring BIS license for export to UAE given re-export risk profile. "
        "Entity List match score contributed +0.58 toward denial. "
        "Re-export pathway analysis contributed +0.27 toward denial: UAE declared as "
        "end destination, however entity has no verifiable end-use history and no "
        "end-user certificate is on file — re-export risk to sanctioned jurisdiction flagged. "
        "License exception EAR99 claimed by applicant is invalid for ECCN 2B001 "
        "equipment — contributed +0.19 toward denial. "
        "OFAC SDN cross-reference: no exact match, but two organizational aliases "
        "share registered address — flagged for human compliance review. "
        "Counterfactual: if Entity List match score were below 0.85 and a valid "
        "end-user certificate were on file, transaction would proceed to manual "
        "compliance officer review rather than automatic denial. "
        "No shipment may proceed. BIS license application required before re-evaluation. "
        "Policy basis: export_policy_2026_v3, EAR Part 744, OFAC SDN screening protocol."
    ),
    reasoning_method="rule_trace",
    confidence=0.94,
    human_review_required=True,
    affected_party_id="nexus-precision-components-ltd",
    data_quality_flags=["no_end_user_certificate", "re_export_risk_unverified"],
    risk_classification="HIGH",
    feature_attribution={
        "entity_list_match_0.94": +0.58,
        "re_export_pathway_unverified": +0.27,
        "invalid_license_exception_EAR99": +0.19,
        "ofac_address_alias_overlap": +0.12,
        "no_end_user_certificate": +0.10,
        "no_prior_transaction_history": +0.08
    },
    human_oversight={
        "required": True,
        "policy_basis": (
            "export_policy_2026_v3 Section 4.2 — automatic denial at Entity List "
            "match ≥0.85; OFAC alias flag requires compliance officer sign-off"
        ),
        "reviewer_role": "licensed_export_compliance_officer",
        "minimum_review_seconds": 180
    }
)

record.print_summary()
print(f"Chain integrity: {'VERIFIED' if record.verify_integrity() else 'FAILED'}")
print()

# ── Record 2: Low-risk approval — same agent, chain advances ─────────────────

record2 = client.record(
    decision_type="export_eligibility",
    input_summary={
        "entity_name": "Henriksen Industrial Supply AS",
        "entity_country": "Norway",
        "end_destination_declared": "Norway",
        "product_description": "Industrial bearings, standard tolerance",
        "eccn_classification": "EAR99",
        "license_exception_claimed": "EAR99",
        "end_user_certificate_on_file": True,
        "prior_transactions": 14
    },
    output={
        "decision": "APPROVED",
        "denial_basis": None,
        "entity_list_match_score": 0.02,
        "license_exception_valid": True
    },
    reasoning=(
        "Export eligibility APPROVED at 0.97 confidence. "
        "Entity 'Henriksen Industrial Supply AS' returns Entity List match score of 0.02 — "
        "well below 0.85 denial threshold. "
        "ECCN classification EAR99 is confirmed appropriate for standard industrial bearings "
        "— no export control license required. "
        "Norway is a NATO ally with no active export restrictions under EAR or ITAR. "
        "End-user certificate on file and validated. "
        "14 prior transactions with entity — no adverse history. "
        "OFAC SDN cross-reference: no match. "
        "Entity List match score contributed -0.61 toward approval (low risk). "
        "Valid ECC classification contributed -0.42 toward approval. "
        "Established transaction history contributed -0.28 toward approval. "
        "No counterfactual trigger: all risk indicators within approved thresholds. "
        "Policy basis: export_policy_2026_v3, EAR Part 740."
    ),
    reasoning_method="rule_trace",
    confidence=0.97,
    human_review_required=False,
    affected_party_id="henriksen-industrial-supply-as",
    risk_classification="LOW",
    feature_attribution={
        "entity_list_match_0.02": -0.61,
        "valid_EAR99_classification": -0.42,
        "established_transaction_history_14": -0.28,
        "nato_ally_destination": -0.22,
        "end_user_certificate_valid": -0.18,
        "ofac_no_match": -0.15
    }
)

record2.print_summary()
print(f"Chain integrity: {'VERIFIED' if record2.verify_integrity() else 'FAILED'}")
print(f"\nChain link verified: {record.record_hash[:16]}... → {record2.previous_hash[:16]}...")
