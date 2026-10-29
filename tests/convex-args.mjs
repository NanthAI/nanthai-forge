// SPDX-License-Identifier: Apache-2.0
import { convexToJson, jsonToConvex } from 'convex/values';

const functions = new WeakMap();
const schemas = new WeakMap();
const object = value =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = (kind, path) => {
  throw new Error(`${kind} at ${path}`);
};

// Compile each exported validator once, including its nested fields. Synthetic IDs
// remain strings: this fake does not model Convex's opaque, table-encoded IDs.
function compile(spec) {
  const type = spec.type;
  if (type === 'object') {
    const fields = Object.entries(spec.value).map(([key, field]) => [
      key,
      field.optional,
      compile(field.fieldType),
    ]);
    return (value, path, kind) => {
      if (!object(value)) fail(kind, path);
      for (const key of Object.keys(value))
        if (!Object.hasOwn(spec.value, key) && value[key] !== undefined)
          fail(kind, `${path}.${key} (extra field)`);
      for (const [key, optional, check] of fields) {
        if (value[key] === undefined) {
          if (!optional) fail(kind, `${path}.${key} (missing)`);
        } else check(value[key], `${path}.${key}`, kind);
      }
    };
  }
  if (type === 'array') {
    const check = compile(spec.value);
    return (value, path, kind) => {
      if (!Array.isArray(value)) fail(kind, path);
      for (let i = 0; i < value.length; i++) check(value[i], `${path}[${i}]`, kind);
    };
  }
  if (type === 'record') {
    const keyCheck = compile(spec.keys),
      valueCheck = compile(spec.values.fieldType);
    return (value, path, kind) => {
      if (!object(value)) fail(kind, path);
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue; // Convex object serialization omits undefined.
        keyCheck(key, `${path}.${key} (key)`, kind);
        valueCheck(item, `${path}.${key}`, kind);
      }
    };
  }
  if (type === 'union' && spec.value.every(member => member.type === 'literal')) {
    const literals = new Set(spec.value.map(member => jsonToConvex(member.value)));
    return (value, path, kind) => {
      if (!literals.has(value)) fail(kind, path);
    };
  }
  if (type === 'union') {
    const members = spec.value.map(compile);
    return (value, path, kind) => {
      for (const check of members) {
        try {
          check(value, path, kind);
          return;
        } catch {}
      }
      fail(kind, path);
    };
  }
  const literal = type === 'literal' ? jsonToConvex(spec.value) : undefined;
  const predicates = {
    any: value => {
      convexToJson(value);
      return true;
    },
    string: value => typeof value === 'string',
    id: value => typeof value === 'string',
    number: value => typeof value === 'number',
    boolean: value => typeof value === 'boolean',
    null: value => value === null,
    bytes: value => value instanceof ArrayBuffer,
    bigint: value => typeof value === 'bigint' && value >= -(2n ** 63n) && value < 2n ** 63n,
    literal: value => Object.is(value, literal),
  };
  const predicate = predicates[type];
  if (!predicate) throw new Error(`Unsupported validator ${type}`);
  return (value, path, kind) => {
    if (!predicate(value)) fail(kind, path);
  };
}

export function checkArgs(fn, args, name) {
  let check = functions.get(fn.exportArgs);
  if (!check) {
    check = compile(JSON.parse(fn.exportArgs()));
    functions.set(fn.exportArgs, check);
  }
  check(args === undefined ? {} : args, name, 'ArgumentValidationError');
}

export function checkDocument(schema, table, document) {
  // Scheduler fixtures maintain their own synthetic system records; these are
  // provider-owned, outside the user schema. All user tables must be declared.
  if (table.startsWith('_')) return document;
  let tables = schemas.get(schema);
  if (!tables) schemas.set(schema, (tables = new Map()));
  if (!tables.has(table)) {
    if (!schema.tables[table]) throw new Error(`Unknown schema table ${table}`);
    tables.set(table, compile(schema.doc(table).json));
  }
  tables.get(table)(document, table, 'DocumentValidationError');
  return jsonToConvex(convexToJson(document));
}

// Patch undefined deletes a field. Replace/patch may repeat system fields but
// cannot change them. Validate before mutating so even a caught failure is atomic.
export function updatedDocument(old, values, replace = false) {
  const entries = Object.entries(values).filter(([, value]) => !replace || value !== undefined);
  for (const [key, value] of entries)
    if ((key === '_id' || key === '_creationTime') && value !== old[key])
      fail('DocumentValidationError', `${key} (system field changed)`);
  const row = replace ? { _id: old._id, _creationTime: old._creationTime } : { ...old };
  for (const [key, value] of entries) {
    if (value === undefined) delete row[key];
    else row[key] = value;
  }
  return row;
}

export function insertedDocument(schema, table, values, id, creationTime) {
  if (!table.startsWith('_'))
    for (const key of ['_id', '_creationTime'])
      if (Object.hasOwn(values, key) && values[key] !== undefined)
        fail('DocumentValidationError', `${table}.${key} (system field on insert)`);
  return checkDocument(schema, table, { ...values, _id: id, _creationTime: creationTime });
}
