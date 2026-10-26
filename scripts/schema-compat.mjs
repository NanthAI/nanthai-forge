// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const canonical = value =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const equal = (a, b) => canonical(a) === canonical(b);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export function compareSnapshots(previous, current) {
  for (const snapshot of [previous, current])
    if (
      snapshot?.format !== 1 ||
      !snapshot.schemas ||
      typeof snapshot.schemas !== 'object' ||
      Array.isArray(snapshot.schemas)
    )
      throw new Error('Invalid shared schema snapshot (expected format 1 and schemas)');
  const issues = [];
  function resolveRef(snapshot, schema, root, seen = new Set()) {
    if (!schema || typeof schema !== 'object' || !schema.$ref) return { schema, root };
    const ref = schema.$ref,
      [external, pointer] = ref.split('#');
    const targetRoot = external || root,
      key = `${targetRoot}#${pointer ?? ''}`;
    if (seen.has(key)) throw new Error(`Cyclic schema reference without a structural node: ${ref}`);
    seen.add(key);
    // Export IDs contain '#'; exact registry IDs take precedence over JSON pointers.
    let target = snapshot.schemas[ref];
    if (target) {
      const resolved = resolveRef(snapshot, target, ref, seen);
      const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref'));
      return { ...resolved, schema: { ...resolved.schema, ...siblings } };
    }
    target = snapshot.schemas[targetRoot];
    if (!target) throw new Error(`Unresolved schema reference: ${ref}`);
    if (pointer) {
      for (const part of pointer.replace(/^\//, '').split('/'))
        target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (target === undefined) throw new Error(`Unresolved schema reference: ${ref}`);
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref'));
    const resolved = resolveRef(snapshot, target, targetRoot, seen);
    return { ...resolved, schema: { ...resolved.schema, ...siblings } };
  }
  function compare(old, next, path, oldRoot, nextRoot, active = new Set()) {
    ({ schema: old, root: oldRoot } = resolveRef(previous, old, oldRoot));
    ({ schema: next, root: nextRoot } = resolveRef(current, next, nextRoot));
    const found = [],
      add = (kind, detail, before = old, after = next) => {
        found.push({
          path,
          kind,
          detail,
          change: digest({ path, kind, before: before ?? null, after: after ?? null }),
        });
      };
    const pair = `${oldRoot}:${digest(old)}:${nextRoot}:${digest(next)}`;
    if (active.has(pair)) return found;
    active = new Set(active).add(pair);
    if (next === true || equal(next, {})) return found;
    if (old === false) return found;
    if (next === false) {
      add('type-narrowed', 'no previously valid value is accepted');
      return found;
    }
    if (old === true) old = {};
    const oldOptions = old.anyOf ?? old.oneOf,
      nextOptions = next.anyOf ?? next.oneOf;
    if (oldOptions || nextOptions) {
      for (const option of oldOptions ?? [old]) {
        const candidates = (nextOptions ?? [next]).map(candidate =>
          compare(option, candidate, path, oldRoot, nextRoot, active),
        );
        if (!candidates.some(candidate => !candidate.length)) {
          const best = candidates.sort((a, b) => a.length - b.length)[0];
          if (best?.length) found.push(...best);
          else add('type-narrowed', 'union alternative removed');
        }
      }
      return found;
    }
    const values = schema => (Object.hasOwn(schema, 'const') ? [schema.const] : schema.enum);
    const oldValues = values(old),
      nextValues = values(next);
    if (nextValues && (!oldValues || oldValues.some(value => !nextValues.some(item => equal(item, value)))))
      add('enum-narrowed', 'literal or enum values removed', oldValues ?? old, nextValues);
    const types = schema => (schema.type === undefined ? null : [].concat(schema.type));
    const oldTypes = types(old),
      nextTypes = types(next);
    const valueType = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
    if (
      nextTypes &&
      !(oldTypes ?? oldValues?.map(valueType))?.every(
        type => nextTypes.includes(type) || (type === 'integer' && nextTypes.includes('number')),
      )
    )
      add('type-narrowed', `type narrowed to ${nextTypes.join(' | ')}`, oldTypes ?? old, nextTypes);
    const oldProps = old.properties ?? {},
      nextProps = next.properties ?? {};
    for (const name of Object.keys(oldProps)) {
      const field = `${path}.${name}`;
      if (!Object.hasOwn(nextProps, name))
        found.push({
          path: field,
          kind: 'field-removed',
          detail: 'field removed or renamed',
          change: digest({ path: field, kind: 'field-removed', before: oldProps[name] }),
        });
      else found.push(...compare(oldProps[name], nextProps[name], field, oldRoot, nextRoot, active));
    }
    for (const name of next.required ?? []) {
      if (!(old.required ?? []).includes(name)) {
        const field = `${path}.${name}`,
          kind = 'field-required';
        found.push({
          path: field,
          kind,
          detail: 'optional or new field is required',
          change: digest({ path: field, kind, before: oldProps[name] ?? null, after: nextProps[name] }),
        });
      }
    }
    if (next.additionalProperties === false && old.additionalProperties !== false)
      add(
        'type-narrowed',
        'additional object properties are no longer accepted',
        old.additionalProperties ?? true,
        false,
      );
    if (next.additionalProperties && typeof next.additionalProperties === 'object')
      found.push(
        ...compare(
          old.additionalProperties ?? {},
          next.additionalProperties,
          `${path}.*`,
          oldRoot,
          nextRoot,
          active,
        ),
      );
    if (next.propertyNames)
      found.push(
        ...compare(old.propertyNames ?? {}, next.propertyNames, `${path}.[key]`, oldRoot, nextRoot, active),
      );
    if (next.items && typeof next.items === 'object')
      found.push(...compare(old.items ?? {}, next.items, `${path}[]`, oldRoot, nextRoot, active));
    if (next.items === false && old.items !== false)
      add('type-narrowed', 'additional tuple items are no longer accepted', old.items ?? true, false);
    for (
      let index = 0;
      index < Math.max(old.prefixItems?.length ?? 0, next.prefixItems?.length ?? 0);
      index++
    )
      found.push(
        ...compare(
          old.prefixItems?.[index] ?? old.items ?? {},
          next.prefixItems?.[index] ?? next.items ?? {},
          `${path}[${index}]`,
          oldRoot,
          nextRoot,
          active,
        ),
      );
    for (const key of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'])
      if (next[key] !== undefined && (old[key] === undefined || next[key] > old[key]))
        add('constraint-narrowed', `${key} increased`, old[key] ?? null, next[key]);
    for (const key of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'])
      if (next[key] !== undefined && (old[key] === undefined || next[key] < old[key]))
        add('constraint-narrowed', `${key} decreased`, old[key] ?? null, next[key]);
    for (const key of ['pattern', 'format', 'multipleOf', 'uniqueItems', 'allOf', 'not', 'contains'])
      if (next[key] !== undefined && !equal(old[key], next[key]))
        add(
          'constraint-changed',
          `${key} changed; compatibility needs a migration declaration`,
          old[key] ?? null,
          next[key],
        );
    return found;
  }
  for (const [name, schema] of Object.entries(previous.schemas)) {
    if (name === '__shared') continue;
    if (!Object.hasOwn(current.schemas, name))
      issues.push({
        path: name,
        kind: 'schema-removed',
        detail: 'exported schema removed or renamed',
        change: digest({ path: name, kind: 'schema-removed', before: schema }),
      });
    else issues.push(...compare(schema, current.schemas[name], name, name, name));
  }
  return [...new Map(issues.map(issue => [`${issue.path}:${issue.change}`, issue])).values()];
}

export function undeclaredChanges(issues, declarations) {
  if (declarations?.format !== 1 || !Array.isArray(declarations.migrations))
    throw new Error('Invalid declared migrations (expected format 1 and migrations)');
  const declared = new Set();
  for (const entry of declarations.migrations) {
    if (
      !/^[a-f0-9]{64}$/.test(entry?.change) ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim()
    )
      throw new Error('Each migration needs an exact change digest, path and nonempty reason');
    declared.add(`${entry.path}:${entry.change}`);
  }
  return issues.filter(issue => !declared.has(`${issue.path}:${issue.change}`));
}
