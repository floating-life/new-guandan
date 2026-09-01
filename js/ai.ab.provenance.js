/**
 * Immutable provenance helpers shared by the A/B evaluator and its local
 * performance receipt builder.  The identifiers and hashes make a local
 * receipt auditable; they do not attest to a remote machine's identity.
 */
import os from 'node:os';
import { createHash } from 'node:crypto';

export const AB_REPORT_SCHEMA = 'guandan-ai-ab-report-v1';
export const CHECKPOINT_SCHEMA = 'guandan-ai-ab-checkpoint-v3';
export const CHECKPOINT_INTEGRITY_SCHEMA = 'sha256-v1';
export const EVALUATION_ENVIRONMENT_SCHEMA = 'guandan-evaluation-environment-v1';
export const EVALUATION_PROVENANCE_SCHEMA = 'guandan-evaluation-provenance-v1';
export const RUN_SEGMENT_SCHEMA = 'guandan-evaluation-run-segment-v1';
export const PERFORMANCE_BY_RUN_SEGMENT_SCHEMA = 'guandan-ai-performance-by-run-segment-v1';

export function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number'
    || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('provenance 不能包含非有限数值');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('provenance 包含不可序列化值');
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

export function sha256Canonical(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function collectEvaluationEnvironment() {
  const machine = {
    // A receipt needs a stable local-machine discriminator, but should not
    // expose the raw hostname in a report that may later be shared.
    hostnameSha256: createHash('sha256').update(os.hostname()).digest('hex'),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
  };
  const runtime = {
    node: process.version,
    v8: process.versions.v8,
  };
  const payload = {
    schema: EVALUATION_ENVIRONMENT_SCHEMA,
    machine,
    runtime,
  };
  return {
    ...payload,
    environmentSha256: sha256Canonical(payload),
  };
}

export function environmentPayload(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null;
  const { schema, machine, runtime } = environment;
  if (!machine || typeof machine !== 'object' || Array.isArray(machine)
    || !runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  return { schema, machine, runtime };
}

export function environmentHashMatches(environment) {
  const payload = environmentPayload(environment);
  return !!payload && environment.schema === EVALUATION_ENVIRONMENT_SCHEMA
    && isSha256(environment.environmentSha256)
    && environment.environmentSha256 === sha256Canonical(payload);
}
