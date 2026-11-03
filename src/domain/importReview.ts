import type { SourceOrderFieldName } from './sourceTypes';

export const SOURCE_ORDER_FIELD_NAMES = [
  'goodsMovementStatus', 'sourceSheet', 'sourceRow', 'doNo', 'deliveryDate', 'soldToParty',
  'shipToParty', 'materialCode', 'description', 'quantity', 'unit', 'deliveryLeadDays',
  'remark', 'daysOutstanding', 'medication', 'fmrOmed',
] as const satisfies readonly SourceOrderFieldName[];

export const SOURCE_IDENTITY_FIELDS = ['doNo', 'materialCode', 'unit'] as const satisfies readonly SourceOrderFieldName[];

/**
 * Workbook location and rolling day counters are import provenance, not
 * planner-approved business corrections. They stay in each source snapshot
 * but never create an actionable review item.
 */
export const SOURCE_REVIEWABLE_FIELD_NAMES = SOURCE_ORDER_FIELD_NAMES.filter(field =>
  !(['sourceSheet', 'sourceRow', 'deliveryLeadDays', 'daysOutstanding'] as SourceOrderFieldName[]).includes(field),
);

export type ApplySourceCorrectionCommand = {
  type: 'data.applySourceCorrection';
  reviewId: string;
  expectedSourceVersion: number;
  selectedFields: SourceOrderFieldName[];
  reason: string;
};

export type DismissSourceCorrectionCommand = {
  type: 'data.dismissSourceCorrection';
  reviewId: string;
  expectedSourceVersion: number;
  reason: string;
};

export type ImportReviewCommand = ApplySourceCorrectionCommand | DismissSourceCorrectionCommand;

export function isSourceOrderFieldName(value: unknown): value is SourceOrderFieldName {
  return typeof value === 'string' && (SOURCE_ORDER_FIELD_NAMES as readonly string[]).includes(value);
}

export function parseImportReviewCommand(value: unknown): ImportReviewCommand {
  const source = object(value, 'command');
  const type = text(source.type, 'command.type', 80);
  if (type === 'data.dismissSourceCorrection') {
    exact(source, ['type', 'reviewId', 'expectedSourceVersion', 'reason'], 'command');
    return {
      type,
      reviewId: trimmed(source.reviewId, 'command.reviewId', 200),
      expectedSourceVersion: integer(source.expectedSourceVersion, 'command.expectedSourceVersion', 1),
      reason: trimmed(source.reason, 'command.reason', 1_000),
    };
  }
  if (type === 'data.applySourceCorrection') {
    exact(source, ['type', 'reviewId', 'expectedSourceVersion', 'selectedFields', 'reason'], 'command');
    const selectedFields = array(source.selectedFields, 'command.selectedFields', SOURCE_ORDER_FIELD_NAMES.length)
      .map((field, index) => {
        if (!isSourceOrderFieldName(field)) throw new Error(`command.selectedFields[${index}] is not a supported source field.`);
        if (!SOURCE_REVIEWABLE_FIELD_NAMES.includes(field)) throw new Error(`command.selectedFields[${index}] is import provenance and cannot be corrected.`);
        return field;
      });
    if (!selectedFields.length) throw new Error('command.selectedFields must contain at least one field.');
    if (new Set(selectedFields).size !== selectedFields.length) throw new Error('command.selectedFields must not contain duplicates.');
    return {
      type,
      reviewId: trimmed(source.reviewId, 'command.reviewId', 200),
      expectedSourceVersion: integer(source.expectedSourceVersion, 'command.expectedSourceVersion', 1),
      selectedFields,
      reason: trimmed(source.reason, 'command.reason', 1_000),
    };
  }
  throw new Error('command.type is not an import review command.');
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(source: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported.`);
  for (const key of keys) if (!(key in source)) throw new Error(`${path}.${key} is required.`);
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${path} must be an array of ${max} items or fewer.`);
  return value;
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${path} must be text of ${max} characters or fewer.`);
  return value;
}

function trimmed(value: unknown, path: string, max: number): string {
  const result = text(value, path, max).trim();
  if (!result) throw new Error(`${path} cannot be blank.`);
  return result;
}

function integer(value: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error(`${path} must be an integer ${min} or greater.`);
  return value as number;
}
