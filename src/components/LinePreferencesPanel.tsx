import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { LINE_IDS, type LineId } from '../domain/types';
import { validateLinePreferences, type LinePreferences, type ProductLinePreference } from '../domain/linePreferences';
import './LinePreferencesPanel.css';

export function LinePreferencesPanel({ value, onChange, disabled }: { value: LinePreferences; onChange: (value: LinePreferences) => void; disabled: boolean }) {
  const [search, setSearch] = useState('');
  const [entry, setEntry] = useState<ProductLinePreference>({ fsCode: '', packaging: 'Bags', preferredLines: ['PM3'] });
  const [error, setError] = useState('');
  const toggle = (lines: LineId[], line: LineId) => lines.includes(line) ? lines.filter(item => item !== line) : LINE_IDS.filter(item => item === line || lines.includes(item));
  function publish(next: LinePreferences) { try { onChange(validateLinePreferences(next)); setError(''); return true; } catch (reason) { setError(reason instanceof Error ? reason.message : 'Check the line preference.'); return false; } }
  function lines(value: LineId[], change: (lines: LineId[]) => void, label: string) {
    return <div className="line-preference-checks" role="group" aria-label={label}>{LINE_IDS.map(line => <label key={line}><input type="checkbox" checked={value.includes(line)} onChange={() => change(toggle(value, line))}/>{line}</label>)}</div>;
  }
  return <section className="panel form-panel line-preferences-panel"><div className="form-section-heading"><div><h2>Line preferences</h2><p>Plan urgent demand first, then prefer these PMs on the earliest available day. Equal preferred PMs have the same priority.</p></div></div><fieldset disabled={disabled} className="line-preferences-fields">
    <label className="checkbox-label"><input type="checkbox" checked={value.enabled} onChange={event => publish({ ...value, enabled: event.target.checked })}/>Use product line preferences</label>
    <div><strong>Other products / packaging</strong>{lines(value.defaultPreferredLines, defaultPreferredLines => publish({ ...value, defaultPreferredLines }), 'Default preferred PMs')}</div>
    <p className="data-note">If a preferred PM is full, the draft uses another PM on the same day. Existing cards stay in place. Full codes such as 5220M and 5220MER are separate rules.</p>
    <label className="field">Search product or packaging<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="e.g. 5220 or Bulk"/></label>
    <div className="table-scroll"><table><thead><tr><th>FS CODE</th><th>PACKAGING</th><th>PREFERRED PMs</th><th/></tr></thead><tbody>{value.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => `${rule.fsCode} ${rule.packaging}`.toLowerCase().includes(search.toLowerCase())).map(({ rule, index }) => <tr key={index}><td><input aria-label={`Product code ${index + 1}`} required pattern="[0-9]{4,6}[A-Z]*" maxLength={40} value={rule.fsCode} onChange={event => { const rules = value.rules.map((row, i) => i === index ? { ...row, fsCode: event.target.value.toUpperCase() } : row); onChange({ ...value, rules }); }}/></td><td><select aria-label={`Packaging ${rule.fsCode}`} value={rule.packaging} onChange={event => publish({ ...value, rules: value.rules.map((row, i) => i === index ? { ...row, packaging: event.target.value as 'Bags' | 'Bulk' } : row) })}><option>Bags</option><option>Bulk</option></select></td><td>{lines(rule.preferredLines, preferredLines => publish({ ...value, rules: value.rules.map((row, i) => i === index ? { ...row, preferredLines } : row) }), `Preferred PMs ${rule.fsCode} ${rule.packaging}`)}</td><td><button type="button" className="icon-button danger-text" aria-label={`Delete ${rule.fsCode} ${rule.packaging} rule`} onClick={() => publish({ ...value, rules: value.rules.filter((_, i) => i !== index) })}><Trash2 size={16}/></button></td></tr>)}</tbody></table></div>
    <div className="line-preference-add"><label className="field">FS code<input value={entry.fsCode} placeholder="5220M" onChange={event => setEntry({ ...entry, fsCode: event.target.value.toUpperCase() })}/></label><label className="field">Packaging<select value={entry.packaging} onChange={event => setEntry({ ...entry, packaging: event.target.value as 'Bags' | 'Bulk' })}><option>Bags</option><option>Bulk</option></select></label><div><strong>Preferred PMs</strong>{lines(entry.preferredLines, preferredLines => setEntry({ ...entry, preferredLines }), 'New rule preferred PMs')}</div><button type="button" className="button secondary" onClick={() => { if (publish({ ...value, rules: [...value.rules, entry] })) setEntry({ fsCode: '', packaging: 'Bags', preferredLines: ['PM3'] }); }}><Plus size={16}/>Add rule</button></div>
    {error && <p className="data-error" role="alert">{error}</p>}<p className="data-note">Use Save settings to apply these changes to newly generated drafts.</p>
  </fieldset></section>;
}
