// SPDX-License-Identifier: Apache-2.0
// Fakes that call Convex handlers directly skip argument validation; the real
// deployment rejects any field its validator does not describe. Apply it here.
export function checkArgs(fn, args, name) {
  validated(JSON.parse(fn.exportArgs()), args, name);
}
function validated(validator, value, path) {
  const fail = () => {
    throw new Error(`ArgumentValidationError at ${path}: ${JSON.stringify(value)?.slice(0, 200)}`);
  };
  switch (validator.type) {
    case 'any':
      return;
    case 'string':
    case 'id':
      if (typeof value !== 'string') fail();
      return;
    case 'number':
      if (typeof value !== 'number') fail();
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail();
      return;
    case 'null':
      if (value !== null) fail();
      return;
    case 'literal':
      if (value !== validator.value) fail();
      return;
    case 'array':
      if (!Array.isArray(value)) fail();
      value.forEach((item, index) => validated(validator.value, item, `${path}[${index}]`));
      return;
    case 'union':
      for (const option of validator.value)
        try {
          return validated(option, value, path);
        } catch {}
      fail();
      return;
    case 'record':
      if (!value || typeof value !== 'object') fail();
      for (const [key, item] of Object.entries(value))
        validated(validator.values.fieldType, item, `${path}.${key}`);
      return;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
      for (const key of Object.keys(value))
        if (!(key in validator.value) && value[key] !== undefined) {
          path = `${path}.${key} (extra field)`;
          fail();
        }
      for (const [key, field] of Object.entries(validator.value))
        if (value[key] === undefined) {
          if (!field.optional) {
            path = `${path}.${key} (missing)`;
            fail();
          }
        } else validated(field.fieldType, value[key], `${path}.${key}`);
      return;
    default:
      throw new Error(`Unsupported validator ${validator.type} at ${path}`);
  }
}
