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

// Convex rejects any value (argument, return value, stored document, scheduler argument) with an
// object of more than 1024 fields or an array of more than 8192 elements (Issue 0c457ae4: a run's
// per-test-file reports crossed a mutation return and stalled every check above 1024 test files).
export const convexObjectFields = 1024,
  convexArrayElements = 8192;
export function checkConvexValue(value, path = 'value', kind = 'ConvexValueError') {
  if (Array.isArray(value)) {
    if (value.length > convexArrayElements)
      fail(kind, `${path} (array has ${value.length} > ${convexArrayElements} elements)`);
    for (let i = 0; i < value.length; i++) checkConvexValue(value[i], `${path}[${i}]`, kind);
  } else if (object(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined);
    if (keys.length > convexObjectFields)
      fail(kind, `${path} (object has ${keys.length} > ${convexObjectFields} fields)`);
    for (const key of keys) checkConvexValue(value[key], `${path}.${key}`, kind);
  }
}

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
      const reasons = [];
      for (const check of members) {
        try {
          check(value, path, kind);
          return;
        } catch (error) {
          reasons.push(error.message.replace(`${kind} at `, ''));
        }
      }
      // Name why each member refused the value, so a mismatch is findable without a debugger.
      fail(kind, `${path} (no union member matched: ${reasons.join(' | ').slice(0, 400)})`);
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
  checkConvexValue(args, name, 'ArgumentValidationError');
}
/** A function's return value against its declared `returns` validator, as Convex checks it after the
 * handler (a mismatch there is not caught by the handler's own error mapping). */
const returnChecks = new WeakMap();
/** The registered handler without the return check that tests/check-runtime.mjs adds. */
export const rawHandler = Symbol.for('forge.test.rawHandler');
/** The compiled `returns` check, or null when the function declares none (exported as null). */
export function returnsCheck(fn) {
  let check = returnChecks.get(fn.exportReturns);
  if (check === undefined) {
    const spec = JSON.parse(fn.exportReturns());
    check = spec === null ? null : compile(spec);
    returnChecks.set(fn.exportReturns, check);
  }
  return check;
}
export function checkReturns(fn, value, name) {
  const check = returnsCheck(fn);
  if (!check) return;
  // A handler returning undefined is stored and validated as null.
  check(value === undefined ? null : value, name, 'ReturnsValidationError');
}
/** A function's return value as Convex would serialize it. */
export const checkReturn = (value, name) => checkConvexValue(value, name, 'ReturnValueError');

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
  checkConvexValue(document, table, 'DocumentValidationError');
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
