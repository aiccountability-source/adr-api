"""
ADR SDK — Agent Decision Record
Accountability.ai | accountability.ai
Version 0.1 | CC-BY 4.0

A bolt-on SDK for generating tamper-evident, cryptographically verifiable
Agent Decision Records compliant with the ADR Specification v0.1 and
Reasoning Capture Methodology v1.0.

ISBN 978-1-7389042-0-4 / 978-1-7389042-1-1

Three lines to initialize. One call to generate. One call to verify.

Usage:
    from adr_sdk import ADRClient

    client = ADRClient(agent_id="your-agent-id", agent_version="1.0.0")

    record = client.record(
        decision_type="credit_approval",
        input_summary={"applicant_id": "A12345", "score": 712},
        output={"decision": "approved", "confidence": 0.84},
        reasoning="Approved at 84% confidence. Credit score 712 exceeds minimum threshold of 680. "
                  "Income-to-debt ratio contributed +23% toward approval. "
                  "Employment stability contributed +18% toward approval. "
                  "Recent credit inquiries contributed -8%. "
                  "Authorized under CreditPolicy-v2.3.1.",
        reasoning_method="chain_of_thought",
        policy_version="CreditPolicy-v2.3.1",
        jurisdiction=["CA"],
        confidence=0.84
    )

    print(record.adr_id)
    print(record.is_valid())
"""

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict
from enum import Enum

# Ed25519 — production signing
# Requires: pip install cryptography
# In demo/test mode the SDK falls back to HMAC-SHA256.
# For production deployment, provide an Ed25519PrivateKey via ADRClient(signing_key=...).
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PublicFormat, PrivateFormat, NoEncryption
    )
    import base64
    _ED25519_AVAILABLE = True
except ImportError:
    _ED25519_AVAILABLE = False


# ─────────────────────────────────────────────
# Controlled Vocabularies
# ─────────────────────────────────────────────

class ReasoningMethod(str, Enum):
    CHAIN_OF_THOUGHT = "chain_of_thought"
    SHAP = "shap"
    LIME = "lime"
    RULE_TRACE = "rule_trace"
    ATTENTION = "attention"
    INTEGRATED_GRADIENTS = "integrated_gradients"


class DecisionType(str, Enum):
    # Credit
    CREDIT_APPROVAL = "credit_approval"
    CREDIT_LIMIT = "credit_limit"
    RATE_DETERMINATION = "rate_determination"
    # Export
    EXPORT_ELIGIBILITY = "export_eligibility"
    SANCTIONS_SCREEN = "sanctions_screen"
    JURISDICTION_CHECK = "jurisdiction_check"
    # Clinical
    CLINICAL_TRIAGE = "clinical_triage"
    CARE_PATHWAY = "care_pathway"
    DIAGNOSTIC_SUPPORT = "diagnostic_support"
    # Hiring
    HIRING_SCREEN = "hiring_screen"
    CANDIDATE_RANKING = "candidate_ranking"
    BACKGROUND_ASSESSMENT = "background_assessment"
    # Wealth Management / Suitability (Reg BI / FINRA Rule 2111)
    WEALTH_MANAGEMENT = "wealth_management"
    SUITABILITY_RECOMMENDATION = "suitability_recommendation"
    PORTFOLIO_REBALANCING = "portfolio_rebalancing"
    INVESTMENT_RECOMMENDATION = "investment_recommendation"
    # Insurance
    INSURANCE_UNDERWRITING = "insurance_underwriting"
    LIFE_UNDERWRITING = "life_underwriting"
    RISK_ASSESSMENT = "risk_assessment"
    # General
    CONTENT_MODERATION = "content_moderation"
    FRAUD_DETECTION = "fraud_detection"
    NULL_DECISION = "null_decision"


# ─────────────────────────────────────────────
# Compliance Validation
# ─────────────────────────────────────────────

class ComplianceError(Exception):
    """Raised when reasoning fails evidentiary standards."""
    pass


class ComplianceWarning:
    def __init__(self, field: str, message: str, severity: str = "DEFICIENT"):
        self.field = field
        self.message = message
        self.severity = severity  # NON_COMPLIANT or DEFICIENT

    def __repr__(self):
        return f"[{self.severity}] {self.field}: {self.message}"


def validate_reasoning(
    reasoning: str,
    reasoning_method: str,
    confidence: Optional[float],
    decision_type: str,
    data_quality_flags: Optional[List[str]] = None
) -> List[ComplianceWarning]:
    """
    Validates reasoning against the Reasoning Capture Methodology v1.0.
    Returns list of warnings. Raises ComplianceError for hard failures.
    """
    warnings = []
    approved_methods = [m.value for m in ReasoningMethod]

    # Method valid — hard reject
    if reasoning_method not in approved_methods:
        raise ComplianceError(
            f"reasoning_method '{reasoning_method}' is not approved. "
            f"Must be one of: {approved_methods}"
        )

    # Attention-only — not sufficient standalone
    if reasoning_method == ReasoningMethod.ATTENTION:
        warnings.append(ComplianceWarning(
            "reasoning_method",
            "Attention weights are supplementary evidence only. Not sufficient as standalone method.",
            "NON_COMPLIANT"
        ))

    # Substantive length
    word_count = len(reasoning.split())
    high_risk_types = [
        DecisionType.CREDIT_APPROVAL, DecisionType.CLINICAL_TRIAGE,
        DecisionType.HIRING_SCREEN, DecisionType.CARE_PATHWAY,
        DecisionType.WEALTH_MANAGEMENT, DecisionType.SUITABILITY_RECOMMENDATION,
        DecisionType.PORTFOLIO_REBALANCING
    ]
    if word_count < 50:
        warnings.append(ComplianceWarning(
            "reasoning",
            f"Reasoning is {word_count} words. Minimum 50 words required.",
            "NON_COMPLIANT"
        ))
    elif word_count < 80 and decision_type in [t.value for t in high_risk_types]:
        warnings.append(ComplianceWarning(
            "reasoning",
            f"High-risk decision type. 80+ words strongly recommended. Current: {word_count}.",
            "DEFICIENT"
        ))

    # Numeric presence
    import re
    if not re.search(r'\d+\.?\d*%?', reasoning):
        warnings.append(ComplianceWarning(
            "reasoning",
            "No numeric reference found. Reasoning must contain at least one quantitative reference.",
            "NON_COMPLIANT"
        ))

    # Feature reference — at least two input features named (Methodology Section 6.2)
    # Heuristic: look for patterns like "X contributed", "X ratio", "X score", "X of N"
    feature_patterns = re.findall(
        r'\b\w+(?:[_\s]\w+)?\s+(?:contributed|score|ratio|rate|index|value|weight|factor|flag|assessment)',
        reasoning.lower()
    )
    # Also count explicit numeric attributions as feature references
    attribution_patterns = re.findall(r'[+\-]\d+\.?\d*%', reasoning)
    total_feature_refs = len(set(feature_patterns)) + len(attribution_patterns)
    if total_feature_refs < 2:
        warnings.append(ComplianceWarning(
            "reasoning",
            "Fewer than two input features identified. Reasoning must name at least two specific "
            "input features that drove the decision (Methodology Section 6.2).",
            "NON_COMPLIANT"
        ))

    # Counterfactual threshold when confidence < 80%
    if confidence is not None and confidence < 0.80:
        threshold_terms = ["threshold", "would need", "counterfactual", "minimum", "boundary", "would advance", "would change"]
        if not any(term in reasoning.lower() for term in threshold_terms):
            warnings.append(ComplianceWarning(
                "reasoning",
                "Confidence below 80%. Counterfactual threshold must be present in reasoning.",
                "NON_COMPLIANT"
            ))

    # Data quality flags present but not addressed in reasoning
    if data_quality_flags:
        dq_terms = ["stale", "missing", "quality", "freshness", "incomplete", "outdated", "flag"]
        if not any(term in reasoning.lower() for term in dq_terms):
            warnings.append(ComplianceWarning(
                "reasoning",
                f"data_quality_flags present ({data_quality_flags}) but not addressed in reasoning. "
                "Methodology Section 2.2 Element 4 requires data quality issues to be documented.",
                "NON_COMPLIANT"
            ))

    # Confidence alignment
    if confidence is not None and not (0.0 <= confidence <= 1.0):
        warnings.append(ComplianceWarning(
            "confidence",
            f"Confidence {confidence} is out of range [0.0, 1.0].",
            "NON_COMPLIANT"
        ))

    return warnings


# ─────────────────────────────────────────────
# Hash Chain
# ─────────────────────────────────────────────

def canonical_serialize(data: Dict) -> bytes:
    """
    Canonical JSON serialization: keys sorted alphabetically, no whitespace.
    Required for deterministic hash computation.
    """
    return json.dumps(data, sort_keys=True, separators=(',', ':')).encode('utf-8')


def compute_hash(data: Dict) -> str:
    """SHA-256 hash of canonical serialization."""
    return hashlib.sha256(canonical_serialize(data)).hexdigest()


def genesis_hash(agent_id: str, deployment_date: str) -> str:
    """
    Genesis block hash per ADR Specification v0.1 Section 5.1.
    SHA256("ADR-GENESIS-{agent_id}-{deployment_date}")
    """
    genesis_string = f"ADR-GENESIS-{agent_id}-{deployment_date}"
    return hashlib.sha256(genesis_string.encode('utf-8')).hexdigest()


def sign_record(record_hash: str, signing_key=None) -> str:
    """
    Sign a record hash.

    Production path (Ed25519):
        Pass an Ed25519PrivateKey instance as signing_key.
        Requires: pip install cryptography

        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.generate()          # generate once, store securely
        client = ADRClient(..., signing_key=key)

    HMAC-SHA256 path (integration testing only):
        Pass a plain string as signing_key.
        NOT suitable for production — HMAC does not provide non-repudiation.

    Demo mode (no key):
        Returns a placeholder. Chain integrity is still verified via SHA-256 hash.
        Demo mode is suitable for local testing only.
    """
    if signing_key is None:
        return f"demo-sig:{record_hash[:16]}"

    # Ed25519 — production
    if _ED25519_AVAILABLE and isinstance(signing_key, Ed25519PrivateKey):
        signature_bytes = signing_key.sign(record_hash.encode('utf-8'))
        return f"ed25519:{base64.b64encode(signature_bytes).decode('utf-8')}"

    # HMAC-SHA256 — integration testing fallback
    if isinstance(signing_key, str):
        sig = hmac.new(
            signing_key.encode('utf-8'),
            record_hash.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        return f"hmac-sha256:{sig}"

    raise ValueError(
        "signing_key must be an Ed25519PrivateKey instance (production) "
        "or a string (integration testing only). "
        "See ADRClient docstring for Ed25519 setup instructions."
    )


# ─────────────────────────────────────────────
# ADR Record
# ─────────────────────────────────────────────

@dataclass
class ADRecord:
    """
    A single Agent Decision Record.
    Compliant with ADR Specification v0.1.
    """
    # Identity
    adr_id: str
    timestamp: str
    agent_id: str
    agent_version: str

    # Decision
    decision_type: str
    input_summary: Any
    output: Any

    # Reasoning
    reasoning: str
    reasoning_method: str
    confidence: Optional[float]

    # Policy
    policy_version: str
    human_review_required: bool
    jurisdiction: List[str]

    # Chain
    previous_hash: str
    record_hash: str
    signature: str

    # Optional
    affected_party_id: Optional[str] = None
    model_version: Optional[str] = None
    feature_attribution: Optional[Dict] = None
    data_quality_flags: Optional[List[str]] = None
    risk_classification: Optional[str] = None
    human_oversight: Optional[Dict] = None

    # Compliance
    compliance_warnings: List[str] = field(default_factory=list)

    def is_valid(self) -> bool:
        """Returns True if no NON_COMPLIANT warnings present."""
        return not any("NON_COMPLIANT" in w for w in self.compliance_warnings)

    def to_dict(self) -> Dict:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, default=str)

    def verify_integrity(self) -> bool:
        """
        Recomputes record_hash from canonical fields and checks signature.
        Use this to verify a record has not been altered since signing.
        """
        verification_data = {k: v for k, v in self.to_dict().items()
                            if k not in ('record_hash', 'signature', 'compliance_warnings')}
        expected_hash = compute_hash(verification_data)
        return expected_hash == self.record_hash

    def print_summary(self):
        status = "COMPLIANT" if self.is_valid() else "NON-COMPLIANT"
        print(f"\n{'='*60}")
        print(f"ADR RECORD SUMMARY")
        print(f"{'='*60}")
        print(f"ID:           {self.adr_id}")
        print(f"Timestamp:    {self.timestamp}")
        print(f"Agent:        {self.agent_id} v{self.agent_version}")
        print(f"Decision:     {self.decision_type}")
        print(f"Confidence:   {self.confidence}")
        print(f"Policy:       {self.policy_version}")
        print(f"Status:       {status}")
        print(f"Hash:         {self.record_hash[:32]}...")
        print(f"Prev Hash:    {self.previous_hash[:32]}...")
        if self.compliance_warnings:
            print("\nWarnings:")
            for w in self.compliance_warnings:
                print(f"  {w}")
        print(f"{'='*60}\n")


# ─────────────────────────────────────────────
# ADR Client
# ─────────────────────────────────────────────

class ADRClient:
    """
    Primary interface for generating ADR records.

    Initialize once per agent. Records automatically chain.

    Args:
        agent_id:        Registered identifier for this AI system
        agent_version:   Semantic version of deployed system
        policy_version:  Governing policy version
        jurisdiction:    List of applicable jurisdiction codes
        signing_key:     Signing key for record integrity.
                         Production: Ed25519PrivateKey instance.
                         Integration testing: plain string (HMAC-SHA256).
                         Omit for local demo mode only.

                         Production setup:
                             from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
                             key = Ed25519PrivateKey.generate()
                             # Persist key securely — do not regenerate per session
                             client = ADRClient(..., signing_key=key)

        deployment_date: ISO date of deployment (for genesis block). Defaults to today.
        strict_mode:     If True, raises ComplianceError on NON_COMPLIANT records.
                         Recommended for production pipelines. Default False.
    """

    def __init__(
        self,
        agent_id: str,
        agent_version: str,
        policy_version: str = "policy-v1.0",
        jurisdiction: Optional[List[str]] = ["CA"],
        signing_key: Optional[str] = None,
        deployment_date: Optional[str] = None,
        strict_mode: bool = False
    ):
        self.agent_id = agent_id
        self.agent_version = agent_version
        self.policy_version = policy_version
        self.jurisdiction = jurisdiction
        self.signing_key = signing_key
        self.strict_mode = strict_mode
        self.deployment_date = deployment_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Initialize chain with genesis block
        self._last_hash = genesis_hash(agent_id, self.deployment_date)
        self._record_count = 0

    def record(
        self,
        decision_type: str,
        input_summary: Any,
        output: Any,
        reasoning: str,
        reasoning_method: str = "chain_of_thought",
        confidence: Optional[float] = None,
        policy_version: Optional[str] = None,
        jurisdiction: Optional[List[str]] = None,
        human_review_required: bool = False,
        affected_party_id: Optional[str] = None,
        model_version: Optional[str] = None,
        feature_attribution: Optional[Dict] = None,
        data_quality_flags: Optional[List[str]] = None,
        risk_classification: Optional[str] = None,
        human_oversight: Optional[Dict] = None
    ) -> ADRecord:
        """
        Generate a compliant ADR record.

        The reasoning field is the primary evidentiary field.
        It must be contemporaneous — call this at inference time,
        not after the decision has been produced.

        Returns ADRecord with hash chain and signature.
        """
        timestamp = datetime.now(timezone.utc).isoformat()
        adr_id = str(uuid.uuid4())

        # Validate reasoning
        warnings = validate_reasoning(
            reasoning=reasoning,
            reasoning_method=reasoning_method,
            confidence=confidence,
            decision_type=decision_type,
            data_quality_flags=data_quality_flags
        )

        if self.strict_mode and any(w.severity == "NON_COMPLIANT" for w in warnings):
            raise ComplianceError(
                f"Record rejected in strict mode. Warnings: {warnings}"
            )

        # Build record data for hashing
        record_data = {
            "adr_id": adr_id,
            "agent_id": self.agent_id,
            "agent_version": self.agent_version,
            "timestamp": timestamp,
            "decision_type": decision_type,
            "input_summary": input_summary,
            "output": output,
            "reasoning": reasoning,
            "reasoning_method": reasoning_method,
            "confidence": confidence,
            "policy_version": policy_version or self.policy_version,
            "human_review_required": human_review_required,
            "jurisdiction": jurisdiction or self.jurisdiction,
            "previous_hash": self._last_hash,
            "affected_party_id": affected_party_id,
            "model_version": model_version,
            "feature_attribution": feature_attribution,
            "data_quality_flags": data_quality_flags,
            "risk_classification": risk_classification,
            "human_oversight": human_oversight
        }

        # Compute hash and sign
        record_hash = compute_hash(record_data)
        signature = sign_record(record_hash, self.signing_key)

        # Build record
        adr = ADRecord(
            adr_id=adr_id,
            timestamp=timestamp,
            agent_id=self.agent_id,
            agent_version=self.agent_version,
            decision_type=decision_type,
            input_summary=input_summary,
            output=output,
            reasoning=reasoning,
            reasoning_method=reasoning_method,
            confidence=confidence,
            policy_version=policy_version or self.policy_version,
            human_review_required=human_review_required,
            jurisdiction=jurisdiction or self.jurisdiction,
            previous_hash=self._last_hash,
            record_hash=record_hash,
            signature=signature,
            affected_party_id=affected_party_id,
            model_version=model_version,
            feature_attribution=feature_attribution,
            data_quality_flags=data_quality_flags,
            risk_classification=risk_classification,
            human_oversight=human_oversight,
            compliance_warnings=[str(w) for w in warnings]
        )

        # Advance chain
        self._last_hash = record_hash
        self._record_count += 1

        return adr

    def verify_chain(self, records: List[ADRecord]) -> bool:
        """
        Verify integrity of a sequence of ADR records.
        Returns True if chain is unbroken and all signatures valid.
        """
        expected_hash = genesis_hash(self.agent_id, self.deployment_date)

        for i, record in enumerate(records):
            if record.previous_hash != expected_hash:
                print(f"Chain break at record {i}: {record.adr_id}")
                return False
            if not record.verify_integrity():
                print(f"Integrity failure at record {i}: {record.adr_id}")
                return False
            expected_hash = record.record_hash

        return True


# ─────────────────────────────────────────────
# Demo
# ─────────────────────────────────────────────

if __name__ == "__main__":

    print("ADR SDK — Accountability.ai — v0.1")
    print("Demonstrating compliant and non-compliant record generation\n")

    # Initialize client — demo mode (no signing key)
    client = ADRClient(
        agent_id="credit-decision-agent-001",
        agent_version="2.1.0",
        policy_version="CreditPolicy-v2.3.1",
        jurisdiction=["CA"],
        deployment_date="2026-03-01"
    )

    # ── Record 1: Compliant credit approval ──
    r1 = client.record(
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
            "Net positive factors outweigh negative factors by margin of 33 percentage points. "
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

    r1.print_summary()

    # ── Record 2: Non-compliant — generic boilerplate ──
    r2 = client.record(
        decision_type="credit_approval",
        input_summary={"applicant_id": "pseudonym-B3K11"},
        output={"decision": "approved"},
        reasoning="Application approved. Applicant met all required criteria.",
        reasoning_method="chain_of_thought",
        confidence=0.91
    )

    r2.print_summary()

    # ── Record 3: Low confidence hiring — counterfactual required ──
    r3 = client.record(
        decision_type="hiring_screen",
        input_summary={"candidate_id": "pseudonym-C9M44"},
        output={"decision": "referred_for_human_review"},
        reasoning=(
            "Candidate referred for human review at 71% confidence. "
            "Skills match score 68 out of 100 against role requirements. "
            "Confidence below 80% threshold requires counterfactual disclosure: "
            "candidate would advance to interview with skills score of 75 or above. "
            "Gap of 7 points on technical assessment is primary factor. "
            "Protected class attributes were not used: race, gender, age, religion, "
            "national origin, disability status, or any proxy for these attributes. "
            "Authorized under HiringPolicy-v1.1.0."
        ),
        reasoning_method="chain_of_thought",
        confidence=0.71,
        human_review_required=True,
        policy_version="HiringPolicy-v1.1.0"
    )

    r3.print_summary()

    # ── Record 4: Wealth management — stale suitability assessment ──
    wealth_client = ADRClient(
        agent_id="wealth-advisor-v2.1",
        agent_version="2.1.0",
        policy_version="reg_bi_suitability_2026_v2",
        jurisdiction=["US"],
        deployment_date="2026-01-01"
    )

    r4 = wealth_client.record(
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
            "Portfolio rebalancing deferred: referred for advisor review at 74% confidence. "
            "Current equity allocation 72% exceeds IPS target of 55% for clients within 5 years "
            "of retirement by 17 percentage points. Rebalancing value: $408,000. "
            "IPS equity deviation contributed +42% toward rebalancing recommendation. "
            "Retirement proximity (3 years) contributed +38% toward rebalancing recommendation. "
            "Risk tolerance assessment is 14 months old — exceeds the 12-month freshness "
            "threshold under reg_bi_suitability_2026_v2 Section 3.1. Stale assessment "
            "contributed -35% confidence cap. Reg BI standard of care requires current "
            "suitability documentation before execution. Counterfactual: if risk assessment "
            "were current (12 months or less), confidence would rise to 88% and rebalancing "
            "would execute automatically. Human advisor review required before $408,000 "
            "rebalancing proceeds. Policy basis: reg_bi_suitability_2026_v2 and FINRA Rule 2111."
        ),
        reasoning_method="chain_of_thought",
        confidence=0.74,
        human_review_required=True,
        data_quality_flags=["risk_assessment_stale_14mo"],
        feature_attribution={
            "ips_equity_deviation_17pp": +0.42,
            "retirement_proximity_3yr": +0.38,
            "fixed_income_underweight": +0.31,
            "stale_risk_assessment": -0.35,
            "no_client_contact_90d": -0.28
        }
    )

    r4.print_summary()

    # ── Verify chain integrity ──
    records = [r1, r2, r3]
    chain_valid = client.verify_chain(records)
    print(f"Credit agent chain integrity verified: {chain_valid}")

    wealth_records = [r4]
    wealth_chain_valid = wealth_client.verify_chain(wealth_records)
    print(f"Wealth agent chain integrity verified: {wealth_chain_valid}")
    print(f"Total records generated: {client._record_count + wealth_client._record_count}")

    # ── Export sample record as JSON ──
    print("\nSample compliant record (JSON):")
    print(r1.to_json())
