/**
 * Minimal JSON-Schema subset that Groq strict mode (constrained decoding)
 * accepts, with a matching shape validator. We keep the schema hand-written
 * and tiny because Groq's strict mode requires every property to be required
 * and `additionalProperties: false` — Zod-generated schemas (z.toJSONSchema)
 * sometimes emit allOf/if-then constructs that strict mode rejects with a 400.
 */

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  // array
  items?: JsonSchema;
  // string
  enum?: (string | number)[];
  // number
  minimum?: number;
  maximum?: number;
  maximumLength?: number;
}

export type ShapeCheck = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Validate an unknown value against our strict-mode JSON Schema subset. */
export function matchesShape(value: unknown, schema: JsonSchema, path = "$"): ShapeCheck {
  const errors: string[] = [];

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, errors: [`${path}: expected object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`] };
    }
    const obj = value as Record<string, unknown>;
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      const sub = matchesShape(obj[key], propSchema, `${path}.${key}`);
      if (!sub.ok) errors.push(...sub.errors);
    }
    return errors.length ? { ok: false, errors } : { ok: true, value };
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return { ok: false, errors: [`${path}: expected array, got ${typeof value}`] };
    for (let i = 0; i < value.length; i++) {
      const sub = matchesShape(value[i], schema.items ?? { type: "string" }, `${path}[${i}]`);
      if (!sub.ok) errors.push(...sub.errors);
    }
    return errors.length ? { ok: false, errors } : { ok: true, value };
  }

  if (schema.type === "string") {
    if (typeof value !== "string") return { ok: false, errors: [`${path}: expected string, got ${typeof value}`] };
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: "${value}" not in enum ${JSON.stringify(schema.enum)}`);
    if (schema.maximumLength && (value as string).length > schema.maximumLength) {
      errors.push(`${path}: length ${(value as string).length} exceeds ${schema.maximumLength}`);
    }
    return errors.length ? { ok: false, errors } : { ok: true, value };
  }

  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { ok: false, errors: [`${path}: expected integer, got ${typeof value}`] };
    }
    if (schema.minimum !== undefined && (value as number) < schema.minimum) errors.push(`${path}: value below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && (value as number) > schema.maximum) errors.push(`${path}: value above maximum ${schema.maximum}`);
    return errors.length ? { ok: false, errors } : { ok: true, value };
  }

  if (schema.type === "number") {
    if (typeof value !== "number") return { ok: false, errors: [`${path}: expected number, got ${typeof value}`] };
    return { ok: true, value };
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, errors: [`${path}: expected boolean, got ${typeof value}`] };
    return { ok: true, value };
  }

  if (schema.type === "null") {
    if (value !== null) return { ok: false, errors: [`${path}: expected null, got ${typeof value}`] };
    return { ok: true, value };
  }

  return { ok: false, errors: [`${path}: unsupported schema type "${schema.type}"`] };
}