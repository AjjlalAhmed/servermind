// Minimal Zod → JSON-Schema converter for tool parameters.
//
// The MCP/Claude backend consumes Zod shapes directly; the OpenAI-compatible
// backend needs JSON-Schema params. Rather than hand-maintain both (which drifts
// — and did), we keep ONE Zod source in TOOL_SPECS and convert here. Only the
// shapes our tool specs actually use are supported: string, number/int (min/max),
// boolean, enum, and optional wrappers, each carrying its .describe() text.

import type { ZodRawShape, ZodTypeAny } from "zod";

interface JsonSchemaProp {
  type: string;
  description?: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required: string[];
}

export function zodShapeToJsonSchema(shape: ZodRawShape): JsonSchemaObject {
  const properties: Record<string, JsonSchemaProp> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    let s = schema as ZodTypeAny;
    let optional = false;
    // a .describe() may sit on the outer wrapper (e.g. `.optional().describe()`)
    // or the inner type (`.describe().optional()`) — keep whichever we find.
    let description: string | undefined = (s as any).description;
    while (def(s).typeName === "ZodOptional" || def(s).typeName === "ZodDefault") {
      optional = optional || def(s).typeName === "ZodOptional";
      s = def(s).innerType;
      description = description || (s as any).description;
    }
    const prop = fieldToJson(s);
    if (description && !prop.description) prop.description = description;
    properties[key] = prop;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

function def(s: ZodTypeAny): any {
  return (s as any)?._def ?? {};
}

function fieldToJson(s: ZodTypeAny): JsonSchemaProp {
  const d = def(s);
  let out: JsonSchemaProp;
  switch (d.typeName) {
    case "ZodBoolean":
      out = { type: "boolean" };
      break;
    case "ZodNumber": {
      const checks: any[] = d.checks ?? [];
      out = { type: checks.some((c) => c.kind === "int") ? "integer" : "number" };
      for (const c of checks) {
        if (c.kind === "min") out.minimum = c.value;
        else if (c.kind === "max") out.maximum = c.value;
      }
      break;
    }
    case "ZodEnum":
      out = { type: "string", enum: d.values };
      break;
    case "ZodString":
    default:
      out = { type: "string" };
      break;
  }
  const description = (s as any).description;
  if (description) out.description = description;
  return out;
}
