import {HttpError} from './error.js'

export const SUMMARY_FIELDS = [
  'hazard_id', 'source', 'hazard_type', 'severity',
  'area_name', 'occurred_at', 'ingested_at',
];
export const RAW_FIELDS = ['source_ref_id', 'latitude', 'longitude', 'attributes'];

export const SCOPE_FIELDS = {
  summary: SUMMARY_FIELDS,
  full: [...SUMMARY_FIELDS, ...RAW_FIELDS],
};

const KNOWN_FIELDS = new Set(SCOPE_FIELDS.full);

export function allowedFields(scope) {
  const allowed = new Set();
  for (const s of String(scope || '').split(/\s+/))
    for (const f of SCOPE_FIELDS[s] || []) allowed.add(f);
  return allowed;
}


export function resolveFields(scope, requested) {
  const allowed = allowedFields(scope);
  if (allowed.size === 0) throw new HttpError(403, '?', 'Scope has no data access');
  if (requested === undefined) return [...allowed];

  const names = String(requested).split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) throw new HttpError(400, 'invalid_request', 'fields is empty');

  const unknown = names.filter((f) => !KNOWN_FIELDS.has(f));
  if (unknown.length) throw new HttpError(400, 'invalid_request', `Unknown fields: ${unknown.join(', ')}`);

  const denied = names.filter((f) => !allowed.has(f));
  if (denied.length) throw new HttpError(403, 'insufficient_scope', `Scope not allowed to read: ${denied.join(', ')}`);

  return names;
}

export function project(row, fields) {
  const out = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}