// The ticket view's fields on this Jira site: config/jira-fields.json names each by its Jira name and id. At
// start-up the ids are checked against Jira's field list. Names are not unique here ("Reviewer" names 11 fields), so an
// id is kept while it still carries its name, and moves only to the one field with that name; otherwise it is missing.
import { readFileSync } from 'node:fs';
import type { JiraFieldRole, PayloadOf } from '@elfoqsy/contracts';
import { DEFAULT_JIRA_FIELDS } from '@elfoqsy/state';

export type FieldMap = Record<JiraFieldRole, { name: string; id: string }>;

export function loadFieldMap(file: string): FieldMap {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { fields?: Partial<FieldMap> };
  return { ...DEFAULT_JIRA_FIELDS, ...(parsed.fields ?? {}) };
}

/** The map checked against the site's fields: what moved, what is missing, and the map to use. */
export function checkFieldMap(map: FieldMap, siteFields: Array<{ id: string; name: string }>): PayloadOf<'jira.fields'> & { map: FieldMap } {
  const byId = new Map(siteFields.map((f) => [f.id, f.name]));
  const moved: PayloadOf<'jira.fields'>['moved'] = [];
  const missing: PayloadOf<'jira.fields'>['missing'] = [];
  const out = { ...map };
  for (const [role, f] of Object.entries(map) as Array<[JiraFieldRole, { name: string; id: string }]>) {
    if (byId.get(f.id) === f.name) continue;
    const same = siteFields.filter((s) => s.name === f.name);
    if (same.length === 1) {
      moved.push({ role, name: f.name, from: f.id, to: same[0]!.id });
      out[role] = { name: f.name, id: same[0]!.id };
    } else missing.push({ role, name: f.name, id: f.id });
  }
  return { fields: out, moved, missing, map: out };
}
