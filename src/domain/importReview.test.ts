import { describe, expect, it } from 'vitest';
import { parseImportReviewCommand } from './importReview';

describe('import review command parser', () => {
  it('accepts an explicit selective correction with a mandatory reason', () => {
    expect(parseImportReviewCommand({
      type: 'data.applySourceCorrection', reviewId: ' review-1 ', expectedSourceVersion: 3,
      selectedFields: ['deliveryDate', 'quantity'], reason: ' Corrected against customer confirmation. ',
    })).toEqual({
      type: 'data.applySourceCorrection', reviewId: 'review-1', expectedSourceVersion: 3,
      selectedFields: ['deliveryDate', 'quantity'], reason: 'Corrected against customer confirmation.',
    });
  });

  it('accepts dismissal while rejecting blank reasons and invalid field selections', () => {
    expect(parseImportReviewCommand({
      type: 'data.dismissSourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2, reason: 'Workbook is stale.',
    }).type).toBe('data.dismissSourceCorrection');
    expect(() => parseImportReviewCommand({
      type: 'data.dismissSourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2, reason: ' ',
    })).toThrow(/reason cannot be blank/i);
    expect(() => parseImportReviewCommand({
      type: 'data.applySourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2,
      selectedFields: [], reason: 'No selection.',
    })).toThrow(/at least one field/i);
    expect(() => parseImportReviewCommand({
      type: 'data.applySourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2,
      selectedFields: ['quantity', 'quantity'], reason: 'Duplicate.',
    })).toThrow(/duplicates/i);
    expect(() => parseImportReviewCommand({
      type: 'data.applySourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2,
      selectedFields: ['deliveryStatus'], reason: 'Unsupported.',
    })).toThrow(/supported source field/i);
    expect(() => parseImportReviewCommand({
      type: 'data.applySourceCorrection', reviewId: 'review-1', expectedSourceVersion: 2,
      selectedFields: ['daysOutstanding'], reason: 'Rolling SAP counter.',
    })).toThrow(/import provenance/i);
  });
});
