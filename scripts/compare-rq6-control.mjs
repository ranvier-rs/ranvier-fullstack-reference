#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const ranvierPath = valueAfter('--ranvier', 'evidence/hybrid-live-scenarios.json');
const controlPath = valueAfter('--control', 'evidence/plain-axum-control-live-scenarios.json');
const output = valueAfter('--output', 'evidence/ranvier-plain-axum-live-parity.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scenarioName(prefix, orderId) {
  invariant(orderId.startsWith(`${prefix}-`), `order ${orderId} is outside prefix ${prefix}`);
  return orderId.slice(prefix.length + 1);
}

function canonicalResponse(observation) {
  const body = observation.body;
  if (body.status === 'ok') {
    return {
      status: observation.status,
      envelope: 'ok',
      outcome: body.result.outcome,
      reason_codes: body.result.reason_codes ?? [],
    };
  }
  return {
    status: observation.status,
    envelope: 'fault',
    code: body.fault.code,
    failed_step: body.fault.failed_step,
    retryable: body.fault.retryable,
    operator_action_required: body.fault.operator_action_required,
    compensations: body.fault.compensations.map(({ action, status }) => ({ action, status })),
  };
}

function canonicalize(report) {
  return {
    schema_version: report.schema_version,
    scenarios: Object.fromEntries(
      Object.entries(report.scenarios).map(([name, value]) => [name, canonicalResponse(value)]),
    ),
    decisions: report.evidence.decisions.map((decision) => ({
      scenario: scenarioName(report.prefix, decision.order_id),
      outcome: decision.result.outcome,
      reason_codes: decision.result.reason_codes ?? [],
    })),
    audits: report.evidence.audits.map((audit) => ({
      scenario: scenarioName(report.prefix, audit.order_id),
      event_type: audit.event_type,
      terminal_outcome: audit.terminal_outcome,
      reason_codes: audit.reason_codes,
    })),
    side_effect_events: report.evidence.side_effect_events.map((event) => ({
      scenario: scenarioName(report.prefix, event.order_id),
      action: event.action,
      status: event.status,
    })),
    trace_events: report.evidence.trace_events.map((event) => ({
      scenario: scenarioName(report.prefix, event.order_id),
      step: event.step,
      state: event.state,
    })),
    trace_event_count: report.evidence.trace_event_count,
    result: report.result,
  };
}

function inspect(file) {
  const bytes = readFileSync(file);
  const canonical = canonicalize(JSON.parse(bytes.toString('utf8')));
  return {
    path: file,
    raw_sha256: sha256(bytes),
    structural_sha256: sha256(JSON.stringify(canonical)),
    canonical,
  };
}

const ranvier = inspect(ranvierPath);
const control = inspect(controlPath);
invariant(
  ranvier.structural_sha256 === control.structural_sha256,
  'Ranvier and plain Axum behavior/evidence differ structurally',
);
const report = {
  schema_version: '1.0.0',
  excluded_metadata: ['adapter', 'base_url', 'prefix', 'health', 'generated identifiers'],
  ranvier: {
    path: ranvier.path,
    raw_sha256: ranvier.raw_sha256,
    structural_sha256: ranvier.structural_sha256,
  },
  plain_axum_control: {
    path: control.path,
    raw_sha256: control.raw_sha256,
    structural_sha256: control.structural_sha256,
  },
  canonical: ranvier.canonical,
  result: 'pass',
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
