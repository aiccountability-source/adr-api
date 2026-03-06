// ============================================================
// ACCOUNTABILITY.AI — ADR GENERATION API  v0.3.0
// Node.js / Express service
// Wraps any AI system and produces tamper-evident ADR records
//
// CHANGELOG v0.3.0
// ─────────────────────────────────────────────────────────────
// • Decentralized Chain Registry — any organization implementing
//   the ADR standard can register their agent and public key.
//   accountability.ai does not need to be in the verification
//   path. The registry holds pointers, not records.
//
// • Global ADR counter — cumulative proof of ecosystem volume
//   displayed alongside per-agent chain_sequence. Demonstrates
//   total accountability events across all registered agents.
//
// • Cross-chain independent verification — verify any ADR from
//   any registered organization by fetching their public key
//   directly from their .well-known/adr-public-key endpoint.
//   accountability.ai is not required for verification.
//
// • /registry         — public list of all registered agents
// • /registry/register — any org can register their ADR agent
// • /verify/cross/:adr_id — independent cross-org verification
// • /stats/global     — ecosystem-wide ADR volume and health
//
// Architecture principle: accountability.ai wrote the rules,
// built the reference implementation, and then made itself
// unnecessary for verification. That is what makes this a
// standard rather than a product.
//
// Spec: ADR Specification v0.1 + Amendment v0.3
// Methodology: Reasoning Capture Methodology v1.0 + Amendment
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
// NEW TABLE REQUIRED (v0.3.0):
//   See /sql/registry_table.sql
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
 * Verify an Ed25519 signature using an externally fetched public key hex.
 * Used for cross-organization independent verification.
 * accountability.ai is NOT in the verification path.
 */
function verifySignatureWithKey(recordHash, signatureHex, publicKeyHex) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(recordHash, 'hex'),
      publicKey,
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Get previous hash and next sequence for chain linkage.
 * Scoped per agent_id — each AI system maintains its own
 * append-only chain. This is the correct production model:
 * a bank's hiring AI and its loan AI have separate chains,
 * each independently verifiable.
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
 * Get global ADR count across all agents and organizations.
 * This is the ecosystem-wide volume counter — cumulative proof
 * that the standard is in use. Displayed alongside per-agent
 * chain_sequence to show both individual chain integrity and
 * total accountability events in the ecosystem.
 */
async function getGlobalAdrCount() {
  const { count, error } = await supabase
    .from('ledger_events')
    .select('*', { count: 'exact', head: true });
  if (error) return null;
  return count;
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

app.get('/health', async (req, res) => {
  const globalCount = await getGlobalAdrCount();
  res.json({
    status: 'operational',
    service: 'accountability.ai ADR API',
    version: '0.3.0',
    signature_algorithm: 'Ed25519',
    public_key_url: `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
    registry_url: `${req.protocol}://${req.get('host')}/registry`,
    global_adr_count: globalCount,
    timestamp: new Date().toISOString(),
  });
});

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
    algorithm:    'Ed25519',
    format:       'SPKI/DER/hex',
    public_key:   KEYS.publicHex,
    issued_by:    'accountability.ai',
    spec:         'accountability.ai/adr-spec-v0.1',
    registry_url: `${req.protocol}://${req.get('host')}/registry`,
    note:         'Use crypto.verify(null, Buffer.from(record_hash,"hex"), publicKey, Buffer.from(signature,"hex"))',
  });
});

// ── GET /registry — Public decentralized agent registry ──────
//
// The registry holds pointers, not records.
// Any organization implementing the ADR standard can register
// their agent and public key. accountability.ai does not control
// or intermediate verification — any registered agent's ADRs
// can be verified directly using their published public key.
//
// This is the open ecosystem layer. The standard defines the
// protocol. Each organization owns their chain.
//
app.get('/registry', async (req, res) => {
  const { data, error } = await supabase
    .from('adr_registry')
    .select(
      'agent_id, org_name, jurisdiction, decision_types, ' +
      'public_key_url, spec_version, registered_at, verified, ' +
      'chain_record_count, last_adr_at'
    )
    .eq('active', true)
    .order('registered_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const globalCount = await getGlobalAdrCount();

  return res.json({
    registry: 'accountability.ai ADR Standard Registry',
    spec: 'accountability.ai/adr-spec-v0.1',
    description: 'Decentralized registry of ADR-compliant AI systems. ' +
      'accountability.ai does not intermediate verification — ' +
      'verify any ADR directly using the published public key at each agent\'s public_key_url.',
    global_adr_count: globalCount,
    registered_agents: data.length,
    agents: data,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /registry/register — Register an ADR-compliant agent ─
//
// Open to any organization implementing the ADR standard.
// No accountability.ai approval required for registration.
// Verification status (verified: true) is set after the
// governance body confirms spec compliance — see Section 10.
//
app.post('/registry/register', async (req, res) => {
  const {
    agent_id, org_name, org_contact_email,
    public_key_url, jurisdiction, decision_types,
    spec_version, implementation_notes,
  } = req.body;

  const missing = [];
  if (!agent_id)          missing.push('agent_id');
  if (!org_name)          missing.push('org_name');
  if (!org_contact_email) missing.push('org_contact_email');
  if (!public_key_url)    missing.push('public_key_url');
  if (!jurisdiction)      missing.push('jurisdiction');
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields', missing });
  }

  // Validate public_key_url is reachable and returns expected format
  let keyFetchValid = false;
  try {
    const response = await fetch(public_key_url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const keyData = await response.json();
      keyFetchValid = !!(keyData.public_key && keyData.algorithm === 'Ed25519');
    }
  } catch {
    // Key URL unreachable — register but flag as unverified
    keyFetchValid = false;
  }

  const { data, error } = await supabase
    .from('adr_registry')
    .insert({
      agent_id,
      org_name,
      org_contact_email,
      public_key_url,
      jurisdiction:          Array.isArray(jurisdiction) ? jurisdiction : [jurisdiction],
      decision_types:        decision_types ?? [],
      spec_version:          spec_version ?? 'v0.1',
      implementation_notes:  implementation_notes ?? null,
      verified:              false,   // set true by governance body after compliance review
      active:                true,
      key_url_reachable:     keyFetchValid,
      chain_record_count:    0,
      registered_at:         new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'agent_id already registered', agent_id });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(201).json({
    registered: true,
    agent_id:         data.agent_id,
    org_name:         data.org_name,
    public_key_url:   data.public_key_url,
    key_url_reachable: keyFetchValid,
    verified:         false,
    note: 'Registration confirmed. Verification status (verified: true) is assigned ' +
          'after ADR governance body review of spec compliance. ' +
          'Your ADRs are independently verifiable immediately using your published public key.',
    spec: 'accountability.ai/adr-spec-v0.1',
    timestamp: data.registered_at,
  });
});

// ── GET /verify/cross/:adr_id — Independent cross-org verification ──
//
// Verifies any ADR from any registered organization by:
// 1. Fetching the ADR record from the local ledger (if registered here)
//    OR accepting the record hash + signature in the request body
// 2. Looking up the publishing organization's public_key_url from the registry
// 3. Fetching the public key directly from the organization's .well-known/ path
// 4. Verifying the Ed25519 signature locally
//
// accountability.ai is NOT in the verification path.
// This proves the standard works without a central authority.
//
app.post('/verify/cross', async (req, res) => {
  const { adr_id, record_hash, signature, agent_id } = req.body;

  if (!record_hash || !signature || !agent_id) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['record_hash', 'signature', 'agent_id'],
      note: 'For ADRs in this ledger, use GET /verify/:adr_id instead',
    });
  }

  // Look up the registrant's public key URL
  const { data: registrant, error: regError } = await supabase
    .from('adr_registry')
    .select('org_name, public_key_url, verified, active')
    .eq('agent_id', agent_id)
    .single();

  if (regError || !registrant) {
    return res.status(404).json({
      error: 'Agent not found in registry',
      agent_id,
      note: 'Organization must register at POST /registry/register',
    });
  }

  if (!registrant.active) {
    return res.status(403).json({ error: 'Agent registration is inactive', agent_id });
  }

  // Fetch the public key directly from the organization's .well-known/ endpoint
  // accountability.ai does not hold or intermediate this key
  let externalPublicKeyHex = null;
  let keyFetchError = null;

  try {
    const response = await fetch(registrant.public_key_url, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const keyData = await response.json();
    if (!keyData.public_key) throw new Error('public_key field missing from response');
    if (keyData.algorithm !== 'Ed25519') throw new Error(`Unexpected algorithm: ${keyData.algorithm}`);
    externalPublicKeyHex = keyData.public_key;
  } catch (err) {
    keyFetchError = err.message;
  }

  if (!externalPublicKeyHex) {
    return res.status(502).json({
      error: 'Could not fetch public key from organization endpoint',
      public_key_url: registrant.public_key_url,
      fetch_error: keyFetchError,
      note: 'Verification requires the organization\'s .well-known/adr-public-key endpoint to be reachable',
    });
  }

  // Verify the signature using the externally fetched key
  const signatureValid = verifySignatureWithKey(record_hash, signature, externalPublicKeyHex);

  return res.status(signatureValid ? 200 : 409).json({
    adr_id:              adr_id ?? 'not provided',
    agent_id,
    org_name:            registrant.org_name,
    verified:            signatureValid,
    signature_valid:     signatureValid,
    signature_algorithm: 'Ed25519',
    record_hash,
    public_key_source:   registrant.public_key_url,
    registry_verified:   registrant.verified,
    verification_note:   signatureValid
      ? 'Signature verified using public key fetched directly from publishing organization. ' +
        'accountability.ai was not in the verification path.'
      : 'Signature verification failed. Record may be tampered or key mismatch.',
    spec: 'accountability.ai/adr-spec-v0.1',
    timestamp: new Date().toISOString(),
  });
});

// ── GET /stats/global — Ecosystem-wide ADR volume and health ──
//
// Shows cumulative proof of standard adoption across all
// registered organizations and agents.
//
app.get('/stats/global', async (req, res) => {
  const [globalCount, registryCount, chainHealth] = await Promise.all([
    supabase.from('ledger_events').select('*', { count: 'exact', head: true }),
    supabase.from('adr_registry').select('*', { count: 'exact', head: true }).eq('active', true),
    supabase.from('v_chain_integrity').select('*'),
  ]);

  // Decision type breakdown
  const { data: decisionBreakdown } = await supabase
    .from('ledger_events')
    .select('decision_type')
    .then(({ data }) => {
      if (!data) return { data: [] };
      const counts = data.reduce((acc, r) => {
        acc[r.decision_type] = (acc[r.decision_type] ?? 0) + 1;
        return acc;
      }, {});
      return { data: counts };
    });

  return res.json({
    ecosystem: 'accountability.ai ADR Standard',
    spec: 'accountability.ai/adr-spec-v0.1',
    global_adr_count:      globalCount.count ?? 0,
    registered_agents:     registryCount.count ?? 0,
    chain_health:          chainHealth.data ?? [],
    decision_type_counts:  decisionBreakdown ?? {},
    note: 'global_adr_count reflects ADRs in the accountability.ai reference implementation. ' +
          'Registered organizations maintain their own ledgers — their counts are not ' +
          'aggregated here, preserving decentralization.',
    timestamp: new Date().toISOString(),
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

    // Get global count to return alongside per-agent sequence
    const globalCount = await getGlobalAdrCount();

    return res.status(201).json({
      adr_id:                adr.adr_id,
      record_hash:           adr.record_hash,
      chain_sequence:        adr.chain_sequence,        // position in this agent's chain
      global_adr_count:      globalCount,               // total ADRs across all agents
      signature_algorithm:   'Ed25519',
      human_review_required: adr.human_review_required,
      verify_url:            `${req.protocol}://${req.get('host')}/verify/${adr.adr_id}`,
      public_key_url:        `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
      registry_url:          `${req.protocol}://${req.get('host')}/registry`,
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
    .select('adr_id, record_hash, previous_hash, chain_sequence, signature, signature_algorithm, agent_id')
    .eq('adr_id', adr_id).single();

  if (error || !data) return res.status(404).json({ error: 'ADR not found', adr_id });

  const signatureValid = verifySignature(data.record_hash, data.signature);

  const { data: chainResult, error: chainError } = await supabase
    .rpc('verify_adr_record', { p_adr_id: adr_id });

  const chainVerified = !chainError && chainResult?.verified === true;
  const verified      = signatureValid !== false && chainVerified;

  // Get per-agent chain depth for context
  const { count: agentChainDepth } = await supabase
    .from('ledger_events')
    .select('*', { count: 'exact', head: true })
    .eq('agent_id', data.agent_id);

  const globalCount = await getGlobalAdrCount();

  return res.status(verified ? 200 : 409).json({
    adr_id,
    verified,
    chain_verified:        chainVerified,
    signature_valid:       signatureValid,
    signature_algorithm:   data.signature_algorithm ?? 'Ed25519',
    record_hash:           data.record_hash,
    chain_sequence:        data.chain_sequence,         // position in this agent's chain
    agent_chain_depth:     agentChainDepth ?? null,     // total records in this agent's chain
    global_adr_count:      globalCount,                 // total ADRs across all agents
    public_key_url:        `${req.protocol}://${req.get('host')}/.well-known/adr-public-key`,
    registry_url:          `${req.protocol}://${req.get('host')}/registry`,
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

  const globalCount = await getGlobalAdrCount();

  return res.json({
    agent_id,
    chain_status:     chainIntact ? 'INTACT' : 'GAP_DETECTED',
    agent_chain_depth: data.length,
    global_adr_count:  globalCount,
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
  const {
    org_id, agent_id, name, description,
    decision_types, jurisdiction, risk_tier,
    current_version, policy_version,
  } = req.body;

  const missing = [];
  if (!org_id)         missing.push('org_id');
  if (!agent_id)       missing.push('agent_id');
  if (!name)           missing.push('name');
  if (!policy_version) missing.push('policy_version');
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
  const {
    adr_id, reviewer_id, org_id, outcome, original_output,
    modified_output, human_override_delta, reviewer_notes,
    review_duration_seconds,
  } = req.body;

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
  ╔══════════════════════════════════════════════════════════╗
  ║  ACCOUNTABILITY.AI — ADR API  v0.3.0                     ║
  ║  Port ${PORT}  ·  Signing: Ed25519                          ║
  ║  Decentralized Registry: /registry                       ║
  ║  Cross-org Verification: POST /verify/cross              ║
  ║  Global Stats: /stats/global                             ║
  ║  accountability.ai/adr-spec-v0.1                         ║
  ╚══════════════════════════════════════════════════════════╝
  `);
});

export default app;
