#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const baseUrl = valueAfter('--base-url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const prefix = valueAfter('--prefix', 'm420-rq4');
const output = valueAfter('--output', '');
const adapter = valueAfter('--adapter', 'native');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(id, fixture = 'normal') {
  return {
    order_id: `${prefix}-${id}`,
    idempotency_key: `${prefix}-${id}`,
    customer_id: 'customer-gate',
    items: [{ item_id: 'sku-001', quantity: 2 }],
    amount_minor: 12500,
    currency: 'USD',
    payment_reference: 'payment-token-gate',
    fixture,
  };
}

async function jsonFetch(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { status: response.status, body };
}

async function authorize(input) {
  return jsonFetch('/api/order-authorizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

const health = await jsonFetch('/api/health');
assert(health.status === 200, 'health must return 200');
assert(
  ['native', 'hybrid', 'plain-axum-control'].includes(adapter),
  'adapter must be native, hybrid, or plain-axum-control',
);
assert(
  health.body.service === `order-authorization-${adapter}`,
  `health reported ${health.body.service}; expected ${adapter}`,
);

const observations = {};
observations.s1 = await authorize(request('s1'));
observations.s2 = await authorize(request('s2', 'manual_review'));
observations.s3 = await authorize(request('s3', 'policy_rejected'));
observations.s4 = await authorize(request('s4', 'out_of_stock'));
observations.s5 = await authorize(request('s5', 'payment_declined'));
observations.s6 = await authorize(request('s6', 'decision_write_failure'));
const s7Request = request('s7');
observations.s7_first = await authorize(s7Request);
observations.s7_retry = await authorize(s7Request);
observations.s8 = await authorize(request('s8', 'ack_lost_after_commit'));

assert(observations.s1.status === 200 && observations.s1.body.result?.outcome === 'approved', 'S1');
assert(observations.s2.status === 200 && observations.s2.body.result?.outcome === 'manual_review', 'S2');
assert(observations.s3.status === 200 && observations.s3.body.result?.outcome === 'rejected', 'S3');
assert(observations.s4.status === 422 && observations.s4.body.fault?.code === 'inventory_out_of_stock', 'S4');
assert(observations.s5.status === 422 && observations.s5.body.fault?.compensations?.[0]?.action === 'release_inventory', 'S5');
assert(
  observations.s6.status === 503
    && observations.s6.body.fault?.compensations?.map((item) => item.action).join(',') === 'void_payment,release_inventory',
  'S6',
);
assert(JSON.stringify(observations.s7_first) === JSON.stringify(observations.s7_retry), 'S7');
assert(observations.s8.status === 200 && observations.s8.body.result?.outcome === 'approved', 'S8');

const evidenceResponse = await jsonFetch('/api/order-authorizations/evidence');
assert(evidenceResponse.status === 200, 'evidence must return 200');
const evidence = evidenceResponse.body;
const relevant = (entry) => entry.order_id?.startsWith(prefix);
const decisions = evidence.decisions.filter(relevant);
const audits = evidence.audits.filter(relevant);
const effects = evidence.side_effects.events.filter(relevant);
const traces = evidence.traces.filter(relevant);
const effectActions = effects.map((event) => event.action);

assert(decisions.length === 5, `expected 5 decisions, found ${decisions.length}`);
assert(audits.length === 5, `expected 5 audits, found ${audits.length}`);
assert(effects.length === 12, `expected 12 effect events, found ${effects.length}`);
assert(effectActions.filter((action) => action === 'inventory_released').length === 2, 'release count');
assert(effectActions.filter((action) => action === 'payment_voided').length === 1, 'void count');
assert(
  effects.filter((event) => event.order_id === `${prefix}-s8`).every((event) => !['payment_voided', 'inventory_released'].includes(event.action)),
  'S8 must not compensate after successful reconciliation',
);
assert(traces.length > 0, 'domain traces must be visible');

const report = {
  schema_version: '1.0.0',
  adapter,
  base_url: baseUrl,
  prefix,
  health: health.body,
  scenarios: observations,
  evidence: {
    decisions,
    audits,
    side_effect_events: effects,
    trace_events: traces,
    trace_event_count: traces.length,
  },
  result: 'pass',
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(output, serialized, 'utf8');
process.stdout.write(serialized);
