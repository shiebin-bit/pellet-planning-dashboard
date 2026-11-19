import { LINE_IDS, type LineId, type Settings } from './types';

export interface ProductLinePreference {
  fsCode: string;
  packaging: 'Bags' | 'Bulk';
  preferredLines: LineId[];
}

export interface LinePreferences {
  enabled: boolean;
  defaultPreferredLines: LineId[];
  rules: ProductLinePreference[];
}

export function createDefaultLinePreferences(): LinePreferences {
  return { enabled: true, defaultPreferredLines: ['PM3'], rules: [
    { fsCode: '5220', packaging: 'Bags', preferredLines: ['PM1'] },
    { fsCode: '5220M', packaging: 'Bags', preferredLines: ['PM1'] },
    { fsCode: '5220', packaging: 'Bulk', preferredLines: ['PM1', 'PM4'] },
    { fsCode: '5811', packaging: 'Bags', preferredLines: ['PM2'] },
    { fsCode: '5211', packaging: 'Bags', preferredLines: ['PM2'] },
    { fsCode: '5210', packaging: 'Bags', preferredLines: ['PM2', 'PM3'] },
    { fsCode: '5210', packaging: 'Bulk', preferredLines: ['PM2'] },
    { fsCode: '5222', packaging: 'Bags', preferredLines: ['PM2', 'PM4'] },
  ] };
}

/** Match a complete FS token; never slice a SAP material number into a routing code. */
export function exactFsCode(product: { description: string; productCode?: string; materialCode?: string }): string | null {
  const code = product.description.match(/\bFS\s*[-:]?\s*(\d{4,6}[A-Z]*)(?=\s|[-/]|$)/i)?.[1];
  if (code) return code.toUpperCase();
  const literal = product.productCode ?? product.materialCode ?? '';
  return /^\d{4,6}[A-Z]*$/i.test(literal.trim()) ? literal.trim().toUpperCase() : null;
}

export function preferredLinesForProduct(settings: Pick<Settings, 'linePreferences'>, product: { description: string; productCode?: string; materialCode?: string; unit?: 'Bags' | 'MT'; mode?: 'bags' | 'bulk' }): LineId[] {
  const prefs = settings.linePreferences ?? createDefaultLinePreferences();
  if (!prefs.enabled) return [...LINE_IDS];
  const code = exactFsCode(product), packaging = product.unit === 'MT' || product.mode === 'bulk' ? 'Bulk' : 'Bags';
  return [...(prefs.rules.find(rule => rule.fsCode === code && rule.packaging === packaging)?.preferredLines ?? prefs.defaultPreferredLines)];
}

export function getLinePreferenceTier(settings: Pick<Settings, 'linePreferences'>, product: Parameters<typeof preferredLinesForProduct>[1], lineId: LineId): number {
  return preferredLinesForProduct(settings, product).includes(lineId) ? 0 : 1;
}

export function validateLinePreferences(value: unknown): LinePreferences {
  const fail = (message: string): never => { throw new Error(`Line preferences: ${message}`); };
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail('expected an object.');
  const exact = (v: Record<string, unknown>, keys: string[]) => { if (Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !(key in v))) fail('unexpected or missing fields.'); };
  const lines = (v: unknown): LineId[] => {
    if (!Array.isArray(v) || !v.length || v.length > 4 || new Set(v).size !== v.length || v.some(line => !LINE_IDS.includes(line))) return fail('choose one or more distinct PM lines.');
    return LINE_IDS.filter(line => v.includes(line));
  };
  const root = object(value); exact(root, ['enabled', 'defaultPreferredLines', 'rules']);
  if (typeof root.enabled !== 'boolean') fail('enabled must be boolean.');
  if (!Array.isArray(root.rules) || root.rules.length > 1000) fail('choose up to 1,000 product rules.');
  const seen = new Set<string>();
  const rules = (root.rules as unknown[]).map(entry => {
    const row = object(entry); exact(row, ['fsCode', 'packaging', 'preferredLines']);
    const fsCode = typeof row.fsCode === 'string' ? row.fsCode.trim().toUpperCase() : '';
    if (!/^\d{4,6}[A-Z]*$/.test(fsCode) || fsCode.length > 40) fail('use a complete FS code, such as 5220M.');
    if (row.packaging !== 'Bags' && row.packaging !== 'Bulk') fail('packaging must be Bags or Bulk.');
    const key = `${fsCode}|${row.packaging}`;
    if (seen.has(key)) fail('duplicate product and packaging rule.');
    seen.add(key);
    return { fsCode, packaging: row.packaging as 'Bags' | 'Bulk', preferredLines: lines(row.preferredLines) };
  });
  return { enabled: root.enabled as boolean, defaultPreferredLines: lines(root.defaultPreferredLines), rules };
}
