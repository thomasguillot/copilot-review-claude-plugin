// Minimal, dependency-free validator for the subset of JSON Schema the
// review-output contract uses: type, enum, required, properties,
// additionalProperties:false, items, minimum, maximum, minLength.

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value; // "object" | "string" | "number" | "boolean"
}

function checkType(value, expected) {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number";
  return typeOf(value) === expected;
}

function walk(value, schema, path, errors) {
  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path || "root"}: expected ${schema.type}, got ${typeOf(value)}`);
    return; // further checks are meaningless on the wrong type
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || "root"}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path || "root"}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path || "root"}: ${value} is above maximum ${schema.maximum}`);
    }
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    errors.push(`${path || "root"}: string shorter than minLength ${schema.minLength}`);
  }
  if (schema.type === "object") {
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    for (const key of schema.required || []) {
      if (!has(value, key)) errors.push(`${path ? path + "." : ""}${key}: required property missing`);
    }
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!has(props, key)) errors.push(`${path ? path + "." : ""}${key}: unexpected additional property`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (has(value, key)) walk(value[key], sub, path ? `${path}.${key}` : key, errors);
    }
  }
  if (schema.type === "array" && schema.items) {
    value.forEach((item, i) => walk(item, schema.items, `${path}[${i}]`, errors));
  }
}

export function validate(data, schema) {
  const errors = [];
  walk(data, schema, "", errors);
  return { ok: errors.length === 0, errors };
}
