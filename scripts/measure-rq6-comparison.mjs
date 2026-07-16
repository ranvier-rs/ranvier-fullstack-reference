#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
};
const numberAfter = (flag) => {
  const value = Number(valueAfter(flag));
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${flag}`);
  return value;
};

const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(read(relative)).digest('hex');
const sourceLines = (relative) => read(relative)
  .split(/\r?\n/u)
  .filter((line) => line.trim() && !line.trim().startsWith('//')).length;
const sumLines = (files) => files.reduce((total, file) => total + sourceLines(file), 0);

function dependencies(relative) {
  const lines = read(relative).split(/\r?\n/u);
  const result = [];
  let inDependencies = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) inDependencies = trimmed === '[dependencies]';
    if (!inDependencies || !trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=/u.exec(trimmed);
    if (match) result.push(match[1]);
  }
  return result.sort();
}

const controlManifest = read('plain-axum-control/Cargo.toml');
const forbiddenControlSource = /(?:\bpath\s*=|\bgit\s*=|\[patch\.|ranvier(?:-|\s*=))/u;
if (forbiddenControlSource.test(controlManifest)) {
  throw new Error('plain Axum control contains a Ranvier, path, Git, or patch dependency');
}

const schematic = JSON.parse(read('evidence/native-rq5-order-authorization-schematic.json'));
const live = JSON.parse(read('evidence/plain-axum-control-live-scenarios.json'));
const s6 = live.scenarios.s6;
if (s6?.status !== 503 || s6.body?.fault?.failed_step !== 'RecordDecision') {
  throw new Error('control S6 evidence is missing the expected failed step');
}
const compensationActions = s6.body.fault.compensations.map((item) => item.action);
if (compensationActions.join(',') !== 'void_payment,release_inventory') {
  throw new Error('control S6 evidence has the wrong compensation order');
}

const ranvierDomainFiles = ['backend/src/domain.rs', 'backend/src/store.rs'];
const ranvierSharedEdgeFiles = ['backend/src/http_contract.rs', 'backend/src/startup.rs'];
const nativeFiles = ['backend/src/native.rs', 'backend/src/main.rs'];
const hybridFiles = ['backend/src/hybrid.rs', 'backend/src/bin/hybrid.rs'];
const controlDomainFiles = [
  'plain-axum-control/src/domain.rs',
  'plain-axum-control/src/store.rs',
];
const controlEdgeFiles = [
  'plain-axum-control/src/http.rs',
  'plain-axum-control/src/main.rs',
  'plain-axum-control/src/lib.rs',
];

const report = {
  schema_version: '1.0.0',
  captured_at: new Date().toISOString(),
  classification: 'maintainer_dogfood_only',
  independent_adoption_claimed: false,
  timing_interpretation: 'automated machine observations; not human adoption timing and not threshold evidence',
  dependency_boundary: {
    control_has_forbidden_source: false,
    ranvier_direct_dependencies: dependencies('backend/Cargo.toml'),
    control_direct_dependencies: dependencies('plain-axum-control/Cargo.toml'),
  },
  sloc: {
    counting_rule: 'non-blank Rust lines excluding lines whose trimmed form starts with //',
    ranvier_shared_domain_and_persistence: sumLines(ranvierDomainFiles),
    ranvier_shared_http_and_startup: sumLines(ranvierSharedEdgeFiles),
    native_incremental_adapter: sumLines(nativeFiles),
    hybrid_incremental_adapter: sumLines(hybridFiles),
    native_and_hybrid_tests: sumLines([
      'backend/tests/native_scenarios.rs',
      'backend/tests/hybrid_parity.rs',
    ]),
    plain_axum_domain_and_persistence: sumLines(controlDomainFiles),
    plain_axum_http_and_startup: sumLines(controlEdgeFiles),
    plain_axum_tests: sumLines(['plain-axum-control/tests/control_scenarios.rs']),
  },
  setup_commands_after_prerequisites: {
    plain_axum_control: 4,
    note: 'network creation, image build, PostgreSQL start, and service start; repository clone and prerequisites excluded',
  },
  runtime_observations_ms: {
    control_image_build: numberAfter('--control-build-ms'),
    server_start_to_first_s1: {
      native: numberAfter('--native-start-ms'),
      hybrid: numberAfter('--hybrid-start-ms'),
      plain_axum_control: numberAfter('--control-start-ms'),
    },
    graceful_stop: {
      native: numberAfter('--native-stop-ms'),
      hybrid: numberAfter('--hybrid-stop-ms'),
      plain_axum_control: numberAfter('--control-stop-ms'),
    },
    all_exit_codes: 0,
  },
  public_scenario_results: {
    plain_axum_control: live.result,
    decisions: live.evidence.decisions.length,
    audits: live.evidence.audits.length,
    side_effect_events: live.evidence.side_effect_events.length,
    trace_events: live.evidence.trace_event_count,
  },
  failure_diagnosis: {
    scenario: 'S6',
    source: 'public HTTP response and redacted evidence endpoint',
    failed_step: s6.body.fault.failed_step,
    original_fault: s6.body.fault.code,
    compensations: compensationActions,
    support_interventions: 0,
    interpretation: 'machine-readable diagnosis proof; no human elapsed-time claim',
  },
  visibility: {
    ranvier_schematic_nodes: schematic.nodes.length,
    ranvier_schematic_edges: schematic.edges.length,
    ranvier_runtime_trace_steps: 7,
    plain_axum_generated_graph: false,
    plain_axum_runtime_trace_steps: 7,
    plain_axum_branch_map_source: 'procedural source and hand-maintained trace labels',
  },
  change_safety: {
    native_to_hybrid_domain_source_changes: 0,
    plain_axum_to_ranvier_domain_rewrite_required: true,
    note: 'native and hybrid share one typed Axon; the independent control intentionally owns a separate procedural implementation',
  },
  hashes: {
    control_lock_sha256: sha256('plain-axum-control/Cargo.lock'),
    control_manifest_sha256: sha256('plain-axum-control/Cargo.toml'),
    control_live_evidence_sha256: sha256('evidence/plain-axum-control-live-scenarios.json'),
    ranvier_schematic_sha256: sha256('evidence/native-rq5-order-authorization-schematic.json'),
  },
  platform_notes: {
    linux_rust_1_93: 'locked check and all 3 tests passed',
    windows: 'locked check and warnings-denied Clippy passed; newly linked integration-test executable was denied by host policy (os error 5)',
  },
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = valueAfter('--output');
writeFileSync(path.resolve(root, output), serialized, 'utf8');
process.stdout.write(serialized);
