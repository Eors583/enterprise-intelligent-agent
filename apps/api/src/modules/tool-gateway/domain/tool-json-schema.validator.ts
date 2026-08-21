export interface ToolInputValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validator for the deliberately small, closed JSON-Schema subset accepted by
 * the public contract. It never resolves references or executes formats.
 */
export function validateToolJsonInput(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): ToolInputValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

function validateNode(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const type = schema.type;
  if (typeof type !== 'string') {
    errors.push(`${path}: schema type is missing.`);
    return;
  }
  if (!matchesType(type, value)) {
    errors.push(`${path}: expected ${type}.`);
    return;
  }
  if (type === 'object') validateObject(schema, value as Record<string, unknown>, path, errors);
  if (type === 'array') validateArray(schema, value as unknown[], path, errors);
  if (type === 'string') validateString(schema, value as string, path, errors);
  if (type === 'number' || type === 'integer') {
    validateNumber(schema, value as number, path, errors);
  }
}

function validateObject(
  schema: Readonly<Record<string, unknown>>,
  value: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  for (const name of required) {
    if (!(name in value)) errors.push(`${path}.${name}: required property is missing.`);
  }
  for (const [name, child] of Object.entries(value)) {
    const childSchema = properties[name];
    if (!isRecord(childSchema)) {
      errors.push(`${path}.${name}: additional property is not allowed.`);
      continue;
    }
    validateNode(childSchema, child, `${path}.${name}`, errors);
  }
}

function validateArray(
  schema: Readonly<Record<string, unknown>>,
  value: unknown[],
  path: string,
  errors: string[],
): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${path}: fewer than minItems.`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${path}: more than maxItems.`);
  }
  if (!isRecord(schema.items)) {
    errors.push(`${path}: array item schema is missing.`);
    return;
  }
  value.forEach((item, index) =>
    validateNode(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors),
  );
}

function validateString(
  schema: Readonly<Record<string, unknown>>,
  value: string,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength.`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push(`${path}: longer than maxLength.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value is not in enum.`);
  }
}

function validateNumber(
  schema: Readonly<Record<string, unknown>>,
  value: number,
  path: string,
  errors: string[],
): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${path}: below minimum.`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push(`${path}: above maximum.`);
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
