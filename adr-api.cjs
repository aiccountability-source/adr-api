const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const cors = require('cors');

// Deterministic JSON stringifier with sorted keys (canonical equivalent)
function canonicalize(obj) {
  const sortKeys = (o) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      return Object.keys(o).sort().reduce((acc, key) => {
        acc[key] = sortKeys(o[key]);
        return acc;
      }, {});
    } else if (Array.isArray(o)) {
      return o.map(item => sortKeys(item));
    }
    return o;
  };
  return JSON.stringify(sortKeys(obj));
}
const app = express();
app.use(express.json());
app.use(cors());

// Environment variables (set in Railway)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const signingPrivateKey = process.env.SIGNING_PRIVATE_KEY;
const masterApiKey = process.env.MASTER_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Health check
app.get('/', (req, res) => res.send('ADR API is running'));

// Verification endpoint
app.get('/verify-adr/:adrId', async (req, res) => {
  const { adrId } = req.params;
  const { data, error } = await supabase.rpc('verify_adr_record', { p_adr_id: adrId });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Ingestion endpoint
app.post('/adr', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== masterApiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const body = req.body;
  const { agent_id, decision_type, input, output, reasoning, confidence, policy_version, jurisdiction } = body;
  if (!agent_id || !decision_type || !input || !output || !reasoning || !policy_version) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Look up system
  const { data: system, error: sysErr } = await supabase
    .from('systems')
    .select('id, org_id')
    .eq('agent_id', agent_id)
    .single();
  if (sysErr || !system) {
    return res.status(400).json({ error: 'Agent not registered' });
  }

  // Get next chain sequence
  const { data: seqData, error: seqErr } = await supabase
    .rpc('get_next_chain_sequence', { p_agent_id: agent_id });
  if (seqErr) throw seqErr;
  const chain_sequence = seqData;

  // Get previous hash
  let previous_hash = '';
  if (chain_sequence > 1) {
    const { data: prev } = await supabase
      .from('ledger_events')
      .select('record_hash')
      .eq('agent_id', agent_id)
      .eq('chain_sequence', chain_sequence - 1)
      .single();
    previous_hash = prev?.record_hash || '';
  } else {
    const genesisString = `ADR-GENESIS-${agent_id}-${new Date().toISOString().split('T')[0]}`;
    previous_hash = crypto.createHash('sha256').update(genesisString).digest('hex');
  }

  // Build ADR payload (without hash/signature)
  const adrPayload = {
    adr_id: `adr_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
    timestamp: new Date().toISOString(),
    agent_id,
    decision_type,
    input_summary: input,
    output,
    reasoning,
    confidence,
    policy_version,
    jurisdiction,
    previous_hash,
  };

  // Canonicalize and compute record_hash
  const canonical = canonicalize(adrPayload);
  const record_hash = crypto.createHash('sha256').update(canonical).digest('hex');

  // Sign with HMAC-SHA256 using ADR_SIGNING_KEY
const hmacKey = process.env.ADR_SIGNING_KEY;
if (!hmacKey) {
  throw new Error('ADR_SIGNING_KEY environment variable is required');
}
const signature = crypto.createHmac('sha256', hmacKey)
                       .update(record_hash)
                       .digest('hex');

  // Insert into ledger_events
  const insertPayload = {
    adr_id: adrPayload.adr_id,
    org_id: system.org_id,
    system_id: system.id,
    agent_id,
    agent_version: body.agent_version || '1.0.0',
    decision_timestamp: adrPayload.timestamp,
    decision_type,
    input_summary: input,
    output,
    confidence,
    reasoning,
    policy_version,
    jurisdiction,
    previous_hash,
    record_hash,
    signature,
    chain_sequence,
    data_quality_flags: body.data_quality_flags || {},
    agent_chain: body.agent_chain || [],
    evidence_basis: body.evidence_basis || {},
    system_context: body.system_context || {},
    affected_party_id: body.affected_party_id,
  };

  const { error: insertErr } = await supabase
    .from('ledger_events')
    .insert(insertPayload);

  if (insertErr) {
    return res.status(500).json({ error: insertErr.message });
  }

  res.json({ adr: insertPayload, verified: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`ADR API listening on port ${port}`);
});
