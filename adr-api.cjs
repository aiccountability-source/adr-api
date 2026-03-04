// ============================================================
// ACCOUNTABILITY.AI — ADR GENERATION API  v0.2.0
// Node.js / Express service
// Wraps any AI system and produces tamper-evident ADR records
// ============================================================
//
// SETUP:
//   npm install express @supabase/supabase-js ulid crypto dotenv cors helmet
//
// ENV VARS REQUIRED:
//   SUPABASE_URL=https://your-project.supabase.co
//   SUPABASE_SERVICE_KEY=your-service-role-key
//   ADR_SIGNING_PRIVATE_KEY=<hex>  — Ed25519 private key (PKCS8/DER/hex)
//   ADR_SIGNING_PUBLIC_KEY=<hex>   — Ed25519 public key  (SPKI/DER/hex)
//   PORT=3001
//
// KEY GENERATION:
//   node generate-ed25519-keys.js
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

// ── SUPABASE ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Ed25519 SIGNING KEYS ──────────────────────────────────────
//
// Replaces HMAC-SHA256 (symmetric — required shared secret for
// verification, could not support independent third-party audit).
//
// Ed25519 is asymmetric:
//   Private key  — signs records (held only by this service / HSM)
//   Public key   — verifies signatures (published at well-known URL)
//
// Any regulator, auditor, or coalition partner can independently
// verify any ADR signature without contacting accountability.ai.
//
// Spec: ADR Specification v0.1, Section 05
// ─────────────────────────────────────────────────────────────
function loadSigningKeys() {
  const privHex = process.env.ADR_SIGNING_PRIVATE_KEY;
  const pubHex  = process.env.ADR_SIGNING_PUBLIC_KEY;

  if (!privHex || !pubHex) {
    console.warn('⚠  Signing keys not set — running unsigned (dev mode)');
    console.warn('   Run: node generate-ed25519-keys.js');
    return { privateKey: null, publicKey: null, publicHex: null };
  }

  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(pubHex, 'hex'), format: 'der', type: 'spki',
    });

    // Self-test on startup
    const msg = Buffer.from('adr-key-self-test');
    const sig = crypto.sign(null, msg, privateKey);
    if (!crypto.verify(null, msg, publicKey, sig)) {
      throw new Error('Ed25519 self-test failed — keys do not match');
    }

    console.log('✓ Ed25519 signing keys loaded and verified');
    return { privateKey, publicKey, publicHex: pubHex };

  } catch (err) {
    console.error('✗ Ed25519 key load failed:', err.message);
    process.exit(1);
  }
}

const KEYS = loadSigningKeys();

// ============================================================
// CRYPTOGRAPHIC CORE
// ============================================================

/**
 * Canonical serialization — deterministic, spec-ordered JSON.
 * Extension fields excluded to preserve forward compatibility.
 * Spec: Section 05 — Canonical Serialization
 */
function canonicalize(record) {
  return JSON.stringify({
    adr_id:                record.adr_id,
    agent_id:              record.agent_id,
    agent_version:         record.agent_version,
    decision_timestamp:    record.decision_timestamp,
    decision_type:         record.decision_type,
    input_summary:         record.input_summary,
    output:                record.output,
    confidence:            record.confidence,
    reasoning:             record.reasoning,
    policy_version:        record.policy_version,
    jurisdiction:          record.jurisdiction,
    human_review_required: record.human_review_required,
    affected_party_id:     record.affected_party_id ?? null,
    previous_hash:         record.previous_hash,
    chain_sequence:        record.chain_sequence,
  });
}

/**
 * H(n) = SHA256( Payload(n) || H(n-1) )
 */
function hashRecord(canonical) {
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Ed25519 signature of the record_hash.
 * Returns hex string for storage and transmission.
 */
function signRecord(recordHash) {
  if (!KEYS.privateKey) return 'unsigned-dev-mode';
  const sig = crypto.sign(null, Buffer.from(recordHash, 'hex'), KEYS.privateKey);
  return sig.toString('hex');
}

/**
 * Verify an Ed25519 signature against a record_hash.
 * Returns: true | false | null (null = dev mode, cannot verify)
 */
function verifySignature(recordHash, signatureHex) {
  if (!KEYS.publicKey) return null;
  try {
    return crypto.verify(
      null,
      Buffer.from(recordHash, 'hex'),
      KEYS.publicKey,
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Get previous hash and next sequence for chain linkage.
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
    const genesis = crypto
      .createHash('sha256')
      .update(`ADR-GENESIS-${agentId}-${new Date().toISOString().substring(0, 10)}`)
      .digest('hex');
    return { previousHash: genesis, nextSequence: 1 };
  }

  return { previousHash: data.record_hash, nextSequence: data.chain_sequence + 1 };
}

/**
 * Core ADR builder — the only path by which records enter the ledger.
 */
async function generateADR({
  system, org, decisionType, inputSummary, output, confidence, reasoning,
  reasoningMethod, featureAttribution, affectedPartyId, humanReviewRequired,
  dataQualityFlags, agentChain, evidenceBasis, systemContext, coalitionCompliance,
}) {
  const { previousHash, nextSequence } = await getPreviousHash(system.agent_id);
  const adrId             = ulid();
  const decisionTimestamp = new Date().toISOString();

  const partial = {
    adr_id: adrId, agent_id: system.agent_id, agent_version: system.current_version,
    decision_timestamp: decisionTimestamp, decision_type: decisionType,
    input_summary: inputSummary, output, confidence, reasoning,
    policy_version: system.policy_version, jurisdiction: system.jurisdiction,
    human_review_required: humanReviewRequired ?? system.risk_tier === 'high',
    affected_party_id: affectedPartyId ?? null,
    previous_hash: previousHash, chain_sequence: nextSequence,
  };

  const canonical  = canonicalize(partial);
  const recordHash = hashRecord(canonical);
  const signature  = signRecord(recordHash);   // Ed25519

  const { data, error } = await supabase
    .from('ledger_events')
    .insert({
      ...partial,
      org_id: org.id, system_id: system.id,
      reasoning_method:    reasoningMethod ?? 'chain_of_thought',
      feature_attribution: featureAttribution ?? {},
      risk_classification: system.risk_tier,
      record_hash:         recordHash,
      signature,
      signature_algorithm: 'Ed25519',
      data_quality_flags:  dataQualityFlags ?? {},
      agent_chain:         agentChain ?? [],
      evidence_basis:      evidenceBasis ?? {},
      system_context:      systemContext ?? {
        timestamp_source: 'system', environment: process.env.NODE_ENV ?? 'production',
      },
      coalition_compliance: coalitionCompliance ?? {},
      remediation_flag: false,
    })
    .select()
    .single();

  if (error) throw new Error(`ADR insert failed: ${error.message}`);
  return data;
}

// ============================================================
// MIDDLEWARE
// ============================================================
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'API key required' });
  if (key !== process.env.API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  next();
}

// ============================================================
// ROUTES
// ============================================================

app.get('/health', (req, res) => res.json({
  status: 'operational',
  service: 'accountability.ai ADR API',
  version: '0.2.0',
  signature_algorithm: 'Ed25519',
  public_key_url: `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
  timestamp: new Date().toISOString(),
}));

// ── /.well-known/adr-public-key — Trust anchor for independent verification ──
//
// Any regulator, auditor, or coalition partner fetches this URL to obtain
// the public key needed to verify ADR signatures without contacting
// accountability.ai or accessing the ledger.
//
app.get('/.well-known/adr-public-key', (req, res) => {
  if (!KEYS.publicHex) {
    return res.status(503).json({ error: 'Public key not configured — dev mode' });
  }
  res.json({
    algorithm:  'Ed25519',
    format:     'SPKI/DER/hex',
    public_key: KEYS.publicHex,
    issued_by:  'accountability.ai',
    spec:       'accountability.ai/adr-spec-v0.1',
    note:       'Use crypto.verify(null, Buffer.from(record_hash,"hex"), publicKey, Buffer.from(signature,"hex"))',
  });
});

// ── POST /adr ──
app.post('/adr', requireApiKey, async (req, res) => {
  const {
    agent_id, decision_type, input_summary, output, confidence, reasoning,
    reasoning_method, feature_attribution, affected_party_id, human_review_required,
    data_quality_flags, agent_chain, evidence_basis, system_context, coalition_compliance,
  } = req.body;

  const missing = [];
  if (!agent_id)      missing.push('agent_id');
  if (!decision_type) missing.push('decision_type');
  if (!input_summary) missing.push('input_summary');
  if (!output)        missing.push('output');
  if (!reasoning)     missing.push('reasoning');
  if (missing.length) {
    return res.status(400).json({
      error: 'Missing required fields', missing,
      note: 'reasoning MUST be captured at inference time, not reconstructed',
    });
  }

  if (typeof reasoning !== 'string' || reasoning.trim().length < 20) {
    return res.status(400).json({
      error: 'reasoning field insufficient',
      note:  'Minimum 20 characters — full chain-of-thought, not a summary',
    });
  }

  const { data: system, error: sysError } = await supabase
    .from('systems').select('*, orgs(*)')
    .eq('agent_id', agent_id).eq('is_active', true).single();

  if (sysError || !system) {
    return res.status(404).json({ error: 'Agent not registered', agent_id });
  }

  try {
    const adr = await generateADR({
      system, org: system.orgs, decisionType: decision_type, inputSummary: input_summary,
      output, confidence: confidence ?? null, reasoning, reasoningMethod: reasoning_method,
      featureAttribution: feature_attribution, affectedPartyId: affected_party_id,
      humanReviewRequired: human_review_required, dataQualityFlags: data_quality_flags,
      agentChain: agent_chain, evidenceBasis: evidence_basis,
      systemContext: system_context, coalitionCompliance: coalition_compliance,
    });

    return res.status(201).json({
      adr_id:                adr.adr_id,
      record_hash:           adr.record_hash,
      chain_sequence:        adr.chain_sequence,
      signature_algorithm:   'Ed25519',
      human_review_required: adr.human_review_required,
      verify_url:            `${req.protocol}://${req.get('host')}/verify/${adr.adr_id}`,
      public_key_url:        `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
      timestamp:             adr.decision_timestamp,
    });
  } catch (err) {
    console.error('ADR generation error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /verify/:adr_id — Chain + signature verification ──
app.get('/verify/:adr_id', async (req, res) => {
  const { adr_id } = req.params;

  const { data, error } = await supabase
    .from('ledger_events')
    .select('adr_id, record_hash, previous_hash, chain_sequence, signature, signature_algorithm')
    .eq('adr_id', adr_id).single();

  if (error || !data) return res.status(404).json({ error: 'ADR not found', adr_id });

  const signatureValid = verifySignature(data.record_hash, data.signature);

  const { data: chainResult, error: chainError } = await supabase
    .rpc('verify_adr_record', { p_adr_id: adr_id });

  const chainVerified = !chainError && chainResult?.verified === true;
  const verified      = signatureValid !== false && chainVerified;

  return res.status(verified ? 200 : 409).json({
    adr_id,
    verified,
    chain_verified:      chainVerified,
    signature_valid:     signatureValid,
    signature_algorithm: data.signature_algorithm ?? 'Ed25519',
    record_hash:         data.record_hash,
    chain_sequence:      data.chain_sequence,
    public_key_url:      `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
    ...(chainResult ?? {}),
  });
});

// ── GET /adr/:adr_id ──
app.get('/adr/:adr_id', requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from('ledger_events')
    .select('*, systems(name,description), orgs(name,slug), approvals(outcome,reviewed_at,reviewer_notes)')
    .eq('adr_id', req.params.adr_id).single();
  if (error || !data) return res.status(404).json({ error: 'ADR not found' });
  return res.json(data);
});

// ── GET /chain/:agent_id ──
app.get('/chain/:agent_id', requireApiKey, async (req, res) => {
  const { agent_id } = req.params;
  const { limit = 50, offset = 0 } = req.query;

  const { data, error } = await supabase
    .from('ledger_events')
    .select('adr_id,chain_sequence,record_hash,previous_hash,signature,decision_timestamp,decision_type,confidence')
    .eq('agent_id', agent_id)
    .order('chain_sequence', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (error) return res.status(500).json({ error: error.message });

  let chainIntact = true;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].previous_hash !== data[i + 1].record_hash) { chainIntact = false; break; }
  }

  return res.json({
    agent_id,
    chain_status:     chainIntact ? 'INTACT' : 'GAP_DETECTED',
    signature_checks: data.slice(0, 5).map(r => ({
      adr_id: r.adr_id,
      signature_valid: verifySignature(r.record_hash, r.signature),
    })),
    record_count: data.length,
    records:      data,
  });
});

// ── POST /system ──
app.post('/system', requireApiKey, async (req, res) => {
  const { org_id, agent_id, name, description, decision_types, jurisdiction, risk_tier, current_version, policy_version } = req.body;
  const missing = [];
  if (!org_id) missing.push('org_id'); if (!agent_id) missing.push('agent_id');
  if (!name) missing.push('name'); if (!policy_version) missing.push('policy_version');
  if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });

  const { data, error } = await supabase.from('systems').insert({
    org_id, agent_id, name, description,
    decision_types: decision_types ?? [], jurisdiction: jurisdiction ?? [],
    risk_tier, current_version: current_version ?? '0.1.0',
    policy_version, deployed_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json(data);
});

// ── GET /queue ──
app.get('/queue', requireApiKey, async (req, res) => {
  const { data, error } = await supabase.from('v_pending_reviews').select('*').limit(100);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ count: data.length, records: data });
});

// ── POST /approve ──
app.post('/approve', requireApiKey, async (req, res) => {
  const { adr_id, reviewer_id, org_id, outcome, original_output, modified_output,
          human_override_delta, reviewer_notes, review_duration_seconds } = req.body;

  const { data: le, error: leErr } = await supabase
    .from('ledger_events').select('id').eq('adr_id', adr_id).single();
  if (leErr || !le) return res.status(404).json({ error: 'ADR not found' });

  const { data, error } = await supabase.from('approvals').insert({
    ledger_event_id: le.id, adr_id, reviewer_id, org_id, outcome,
    original_output, modified_output,
    human_override_delta,   // structured diff per spec Section 08
    reviewer_notes, review_duration_seconds,
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(201).json(data);
});

// ── GET /stats/:org_id ──
app.get('/stats/:org_id', requireApiKey, async (req, res) => {
  const { org_id } = req.params;
  const [summary, chain, pending] = await Promise.all([
    supabase.from('v_org_decision_summary').select('*').eq('org_id', org_id),
    supabase.from('v_chain_integrity').select('*'),
    supabase.from('v_pending_reviews').select('*', { count: 'exact', head: true }).eq('org_id', org_id),
  ]);
  return res.json({
    org_id,
    summary:         summary.data ?? [],
    chain_status:    chain.data ?? [],
    pending_reviews: pending.count ?? 0,
  });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║  ACCOUNTABILITY.AI — ADR API  v0.2.0                 ║
  ║  Port ${PORT}  ·  Signing: Ed25519                      ║
  ║  accountability.ai/adr-spec-v0.1                     ║
  ╚══════════════════════════════════════════════════════╝
  `);
});

export default app;
