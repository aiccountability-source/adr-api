// ============================================================
// ACCOUNTABILITY.AI — ADR GENERATION API
// Node.js / Express service
// Wraps any AI system and produces tamper-evident ADR records
// ============================================================
// 
// SETUP:
//   npm install express @supabase/supabase-js ulid crypto dotenv cors helmet
//
// ENV VARS REQUIRED:
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_SERVICE_KEY=your-service-role-key   (bypasses RLS for inserts)
//   ADR_SIGNING_KEY=your-ed25519-private-key-hex
//   PORT=3001
// ============================================================

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { ulid } from 'ulid';
import crypto from 'crypto';
import helmet from 'helmet';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── SUPABASE CLIENT (service role — bypasses RLS for ADR inserts) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── SIGNING KEY ──
const SIGNING_KEY = process.env.ADR_SIGNING_KEY;

// ============================================================
// CORE: ADR GENERATION
// ============================================================

/**
 * Canonical serialization — deterministic JSON for hashing.
 * Fields must be in exact spec order for hash reproducibility.
 */
function canonicalize(record) {
  const ordered = {
    adr_id:           record.adr_id,
    agent_id:         record.agent_id,
    agent_version:    record.agent_version,
    decision_timestamp: record.decision_timestamp,
    decision_type:    record.decision_type,
    input_summary:    record.input_summary,
    output:           record.output,
    confidence:       record.confidence,
    reasoning:        record.reasoning,
    policy_version:   record.policy_version,
    jurisdiction:     record.jurisdiction,
    human_review_required: record.human_review_required,
    affected_party_id: record.affected_party_id ?? null,
    previous_hash:    record.previous_hash,
    chain_sequence:   record.chain_sequence,
  };
  return JSON.stringify(ordered);
}

/**
 * SHA-256 hash of canonical record string.
 */
function hashRecord(canonical) {
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 signature using signing key.
 * Replace with Ed25519 in production with proper key management.
 */
function signRecord(hash) {
  if (!SIGNING_KEY) return 'unsigned-dev-mode';
  return crypto
    .createHmac('sha256', SIGNING_KEY)
    .update(hash)
    .digest('hex');
}

/**
 * Get previous hash for chain linkage.
 * Genesis block uses a deterministic seed per agent.
 */
async function getPreviousHash(agentId) {
  const { data, error } = await supabase
    .from('ledger_events')
    .select('record_hash, chain_sequence')
    .eq('agent_id', agentId)
    .order('chain_sequence', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    // Genesis block
    const genesis = crypto
      .createHash('sha256')
      .update(`ADR-GENESIS-${agentId}-${new Date().toISOString().substring(0, 10)}`)
      .digest('hex');
    return { previousHash: genesis, nextSequence: 1 };
  }

  return {
    previousHash: data.record_hash,
    nextSequence: data.chain_sequence + 1
  };
}

/**
 * Core ADR record builder and writer.
 * This is the only path by which records enter the ledger.
 */
async function generateADR({
  system,        // systems row from DB
  org,           // orgs row from DB
  decisionType,
  inputSummary,
  output,
  confidence,
  reasoning,
  reasoningMethod,
  featureAttribution,
  affectedPartyId,
  humanReviewRequired,
  dataQualityFlags,
  agentChain,
  evidenceBasis,
  systemContext,
  coalitionCompliance,
}) {
  // 1. Get chain state
  const { previousHash, nextSequence } = await getPreviousHash(system.agent_id);

  // 2. Build partial record for hashing
  const adrId = ulid();
  const decisionTimestamp = new Date().toISOString();

  const partial = {
    adr_id:               adrId,
    agent_id:             system.agent_id,
    agent_version:        system.current_version,
    decision_timestamp:   decisionTimestamp,
    decision_type:        decisionType,
    input_summary:        inputSummary,
    output:               output,
    confidence:           confidence,
    reasoning:            reasoning,
    policy_version:       system.policy_version,
    jurisdiction:         system.jurisdiction,
    human_review_required: humanReviewRequired ?? system.risk_tier === 'high',
    affected_party_id:    affectedPartyId ?? null,
    previous_hash:        previousHash,
    chain_sequence:       nextSequence,
  };

  // 3. Hash and sign
  const canonical  = canonicalize(partial);
  const recordHash = hashRecord(canonical);
  const signature  = signRecord(recordHash);

  // 4. Full record for DB
  const fullRecord = {
    // Identity
    adr_id:               adrId,
    org_id:               org.id,
    system_id:            system.id,
    agent_id:             system.agent_id,
    agent_version:        system.current_version,

    // Decision
    decision_timestamp:   decisionTimestamp,
    decision_type:        decisionType,
    input_summary:        inputSummary,
    output:               output,
    confidence:           confidence,

    // Reasoning
    reasoning:            reasoning,
    reasoning_method:     reasoningMethod ?? 'chain_of_thought',
    feature_attribution:  featureAttribution ?? {},

    // Policy
    policy_version:       system.policy_version,
    jurisdiction:         system.jurisdiction,
    human_review_required: partial.human_review_required,
    risk_classification:  system.risk_tier,
    affected_party_id:    affectedPartyId ?? null,

    // Integrity
    previous_hash:        previousHash,
    record_hash:          recordHash,
    signature:            signature,
    chain_sequence:       nextSequence,

    // Extensions
    data_quality_flags:   dataQualityFlags ?? {},
    agent_chain:          agentChain ?? [],
    evidence_basis:       evidenceBasis ?? {},
    system_context:       systemContext ?? {
      timestamp_source:   'system',
      environment:        process.env.NODE_ENV ?? 'production',
    },
    coalition_compliance: coalitionCompliance ?? {},
    remediation_flag:     false,
  };

  // 5. Insert — single atomic write
  const { data, error } = await supabase
    .from('ledger_events')
    .insert(fullRecord)
    .select()
    .single();

  if (error) {
    throw new Error(`ADR insert failed: ${error.message}`);
  }

  return data;
}

// ============================================================
// MIDDLEWARE: API Key Auth
// ============================================================
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'API key required' });
  }
  // In production: look up key in DB, scope to org
  // For now: env var
  if (key !== process.env.API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  next();
}

// ============================================================
// ROUTES
// ============================================================

// ── Health ──
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    service: 'accountability.ai ADR API',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ── POST /adr — Generate a new ADR record ──
//
// This is the primary endpoint. Your AI system calls this
// immediately after producing a decision, passing the full
// decision context. The API handles hashing, chaining, signing.
//
// Body:
//   agent_id          string   — registered agent identifier
//   decision_type     string   — from controlled vocabulary
//   input_summary     object   — pseudonymized inputs
//   output            object   — exact AI output
//   confidence        number   — 0-100
//   reasoning         string   — REQUIRED, captured at inference
//   reasoning_method  string   — optional
//   feature_attribution object — optional SHAP/LIME weights
//   affected_party_id string   — optional, pseudonymized
//   human_review_required boolean — optional override
//   data_quality_flags object  — optional
//   agent_chain       string[] — optional, upstream adr_ids
//   evidence_basis    object   — optional RAG context
//   system_context    object   — optional
//
app.post('/adr', requireApiKey, async (req, res) => {
  const {
    agent_id,
    decision_type,
    input_summary,
    output,
    confidence,
    reasoning,
    reasoning_method,
    feature_attribution,
    affected_party_id,
    human_review_required,
    data_quality_flags,
    agent_chain,
    evidence_basis,
    system_context,
    coalition_compliance,
  } = req.body;

  // Validate required fields
  const missing = [];
  if (!agent_id)      missing.push('agent_id');
  if (!decision_type) missing.push('decision_type');
  if (!input_summary) missing.push('input_summary');
  if (!output)        missing.push('output');
  if (!reasoning)     missing.push('reasoning');

  if (missing.length) {
    return res.status(400).json({
      error: 'Missing required fields',
      missing,
      note: 'reasoning is REQUIRED and must be captured at inference time, not reconstructed'
    });
  }

  // Validate reasoning quality — reject post-hoc reconstructions
  if (typeof reasoning !== 'string' || reasoning.trim().length < 20) {
    return res.status(400).json({
      error: 'reasoning field insufficient',
      note: 'Provide the full chain-of-thought or structured explanation — not a summary'
    });
  }

  // Look up registered system
  const { data: system, error: sysError } = await supabase
    .from('systems')
    .select('*, orgs(*)')
    .eq('agent_id', agent_id)
    .eq('is_active', true)
    .single();

  if (sysError || !system) {
    return res.status(404).json({
      error: 'Agent not registered',
      agent_id,
      note: 'Register this system at /system before generating ADRs'
    });
  }

  try {
    const adr = await generateADR({
      system,
      org: system.orgs,
      decisionType:        decision_type,
      inputSummary:        input_summary,
      output,
      confidence:          confidence ?? null,
      reasoning,
      reasoningMethod:     reasoning_method,
      featureAttribution:  feature_attribution,
      affectedPartyId:     affected_party_id,
      humanReviewRequired: human_review_required,
      dataQualityFlags:    data_quality_flags,
      agentChain:          agent_chain,
      evidenceBasis:       evidence_basis,
      systemContext:       system_context,
      coalitionCompliance: coalition_compliance,
    });

    return res.status(201).json({
      adr_id:           adr.adr_id,
      record_hash:      adr.record_hash,
      chain_sequence:   adr.chain_sequence,
      human_review_required: adr.human_review_required,
      verify_url:       `${req.protocol}://${req.get('host')}/verify/${adr.adr_id}`,
      timestamp:        adr.decision_timestamp,
    });

  } catch (err) {
    console.error('ADR generation error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /verify/:adr_id — Public verification endpoint ──
//
// Any party can call this to verify a record's chain integrity.
// No auth required — this is the public trust surface.
//
app.get('/verify/:adr_id', async (req, res) => {
  const { adr_id } = req.params;

  const { data, error } = await supabase
    .rpc('verify_adr_record', { p_adr_id: adr_id });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const status = data?.verified ? 200 : 409;
  return res.status(status).json(data);
});

// ── GET /adr/:adr_id — Retrieve a single ADR ──
app.get('/adr/:adr_id', requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from('ledger_events')
    .select(`
      *,
      systems(name, description),
      orgs(name, slug),
      approvals(outcome, reviewed_at, reviewer_notes)
    `)
    .eq('adr_id', req.params.adr_id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'ADR not found' });
  }

  return res.json(data);
});

// ── GET /chain/:agent_id — Get chain integrity status ──
app.get('/chain/:agent_id', requireApiKey, async (req, res) => {
  const { agent_id } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  const { data, error } = await supabase
    .from('ledger_events')
    .select('adr_id, chain_sequence, record_hash, previous_hash, decision_timestamp, decision_type, confidence')
    .eq('agent_id', agent_id)
    .order('chain_sequence', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });

  // Verify chain locally
  let chainIntact = true;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].previous_hash !== data[i + 1].record_hash) {
      chainIntact = false;
      break;
    }
  }

  return res.json({
    agent_id,
    chain_status: chainIntact ? 'INTACT' : 'GAP_DETECTED',
    record_count: data.length,
    records: data,
  });
});

// ── POST /system — Register a new AI agent ──
app.post('/system', requireApiKey, async (req, res) => {
  const {
    org_id, agent_id, name, description,
    decision_types, jurisdiction, risk_tier,
    current_version, policy_version
  } = req.body;

  const missing = [];
  if (!org_id)         missing.push('org_id');
  if (!agent_id)       missing.push('agent_id');
  if (!name)           missing.push('name');
  if (!policy_version) missing.push('policy_version');

  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields', missing });
  }

  const { data, error } = await supabase
    .from('systems')
    .insert({
      org_id, agent_id, name, description,
      decision_types: decision_types ?? [],
      jurisdiction:   jurisdiction ?? [],
      risk_tier,
      current_version: current_version ?? '0.1.0',
      policy_version,
      deployed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(201).json(data);
});

// ── GET /queue — Pending human review queue ──
app.get('/queue', requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from('v_pending_reviews')
    .select('*')
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ count: data.length, records: data });
});

// ── POST /approve — Submit human review outcome ──
app.post('/approve', requireApiKey, async (req, res) => {
  const {
    adr_id, reviewer_id, org_id, outcome,
    original_output, modified_output,
    reviewer_notes, review_duration_seconds
  } = req.body;

  // Get the ledger_event id
  const { data: le, error: leErr } = await supabase
    .from('ledger_events')
    .select('id')
    .eq('adr_id', adr_id)
    .single();

  if (leErr || !le) {
    return res.status(404).json({ error: 'ADR not found' });
  }

  const { data, error } = await supabase
    .from('approvals')
    .insert({
      ledger_event_id: le.id,
      adr_id,
      reviewer_id,
      org_id,
      outcome,
      original_output,
      modified_output,
      reviewer_notes,
      review_duration_seconds,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json(data);
});

// ── GET /stats/:org_id — Org-level dashboard stats ──
app.get('/stats/:org_id', requireApiKey, async (req, res) => {
  const { org_id } = req.params;

  const [summary, chain, pending] = await Promise.all([
    supabase
      .from('v_org_decision_summary')
      .select('*')
      .eq('org_id', org_id),
    supabase
      .from('v_chain_integrity')
      .select('*'),
    supabase
      .from('v_pending_reviews')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', org_id),
  ]);

  return res.json({
    org_id,
    summary:      summary.data ?? [],
    chain_status: chain.data ?? [],
    pending_reviews: pending.count ?? 0,
  });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`
  ==========================================
  ACCOUNTABILITY.AI -- ADR API
  v0.1.0 -- Port ${PORT}
  accountability.ai/adr-spec-v0.1.pdf
  ==========================================
  `);
});

export default app;
