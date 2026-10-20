import { useEffect, useMemo, useState } from 'react';
import { Archive, Pencil, Plus, RotateCcw, Save, Search, X } from 'lucide-react';
import type { Command } from '../domain/commands';
import type { CatalogProduct, QuantityMode } from '../domain/types';
import { useWorkspace } from '../lib/workspace';
import './CatalogPanel.css';

type CatalogDraft = Pick<CatalogProduct, 'code' | 'description' | 'defaultMode'>;
type CatalogCommandType = Extract<Command['type'], 'catalog.create' | 'catalog.update' | 'catalog.setActive'>;

const EMPTY_DRAFT: CatalogDraft = { code: '', description: '', defaultMode: 'bags' };
const PAGE_SIZE = 20;

export function CatalogPanel() {
  const {
    state, commit, busy, storageWarning, storageMode, refresh, hasConflict, resolveConflict,
    mutationLocked, confirmedRetry,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<CatalogDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<CatalogDraft | null>(null);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [pending, setPending] = useState<{
    type: CatalogCommandType;
    productId?: string;
    afterConfirmation: number;
  } | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...state.catalog]
      .filter(product => !normalized
        || product.code.toLowerCase().includes(normalized)
        || product.description.toLowerCase().includes(normalized))
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return left.code.localeCompare(right.code, undefined, { numeric: true, sensitivity: 'base' });
      });
  }, [query, state.catalog]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const editingProduct = editingId ? state.catalog.find(product => product.id === editingId) : undefined;

  useEffect(() => {
    if (!pending || !confirmedRetry || confirmedRetry.nonce <= pending.afterConfirmation) return;
    if (confirmedRetry.type !== pending.type) return;
    finishOperation(pending.type);
  }, [confirmedRetry?.nonce]);

  useEffect(() => {
    if (pending && storageWarning) setFeedback({ message: storageWarning, error: true });
  }, [storageWarning, pending]);

  function finishOperation(type: CatalogCommandType) {
    if (type === 'catalog.create') {
      setAdding(false);
      setAddDraft(EMPTY_DRAFT);
      setFeedback({ message: 'Catalog product added.', error: false });
    } else if (type === 'catalog.update') {
      setEditingId(null);
      setEditDraft(null);
      setFeedback({ message: 'Catalog product updated.', error: false });
    } else {
      setFeedback({ message: 'Catalog availability updated.', error: false });
    }
    setPending(null);
  }

  function validate(draft: CatalogDraft, currentId?: string): string {
    const code = draft.code.trim();
    const description = draft.description.trim();
    if (!code) return 'Enter a product code.';
    if (!description) return 'Enter a product name or description.';
    if (code.length > 80) return 'Product code must be 80 characters or fewer.';
    if (description.length > 200) return 'Product description must be 200 characters or fewer.';
    const duplicate = state.catalog.some(product =>
      product.id !== currentId && product.code.trim().toLowerCase() === code.toLowerCase(),
    );
    return duplicate ? `Product code ${code} already exists, including among inactive products.` : '';
  }

  function beginPending(type: CatalogCommandType, productId?: string) {
    setPending({ type, productId, afterConfirmation: confirmedRetry?.nonce ?? 0 });
    setFeedback({ message: 'Saving catalog change…', error: false });
  }

  async function addProduct(event: React.FormEvent) {
    event.preventDefault();
    if (hasConflict) return;
    const validation = validate(addDraft);
    if (validation) { setFeedback({ message: validation, error: true }); return; }
    const input = {
      code: addDraft.code.trim(),
      description: addDraft.description.trim(),
      defaultMode: addDraft.defaultMode,
    };
    beginPending('catalog.create');
    const saved = await commit({ type: 'catalog.create', input }, 'Catalog product added.');
    if (saved) finishOperation('catalog.create');
    else setFeedback({ message: 'The product was not saved. Your draft is preserved.', error: true });
  }

  async function updateProduct(event: React.FormEvent) {
    event.preventDefault();
    if (!editingId || !editDraft || hasConflict) return;
    const validation = validate(editDraft, editingId);
    if (validation) { setFeedback({ message: validation, error: true }); return; }
    const patch = {
      code: editDraft.code.trim(),
      description: editDraft.description.trim(),
      defaultMode: editDraft.defaultMode,
    };
    beginPending('catalog.update', editingId);
    const saved = await commit(
      { type: 'catalog.update', productId: editingId, patch },
      'Catalog product updated. Existing production records keep their saved details.',
    );
    if (saved) finishOperation('catalog.update');
    else setFeedback({ message: 'The product was not saved. Your draft is preserved.', error: true });
  }

  async function setActive(product: CatalogProduct, active: boolean) {
    if (hasConflict) return;
    beginPending('catalog.setActive', product.id);
    const saved = await commit(
      { type: 'catalog.setActive', productId: product.id, active },
      active ? `${product.code} is available for new production.` : `${product.code} is hidden from new-production suggestions.`,
    );
    if (saved) finishOperation('catalog.setActive');
    else setFeedback({ message: 'Availability was not changed. You can retry safely.', error: true });
  }

  function startEdit(product: CatalogProduct) {
    setAdding(false);
    setEditingId(product.id);
    setEditDraft({ code: product.code, description: product.description, defaultMode: product.defaultMode });
    setFeedback(null);
  }

  return <section className="panel catalog-panel" aria-labelledby="catalog-title">
    <div className="catalog-heading">
      <div>
        <span className="eyebrow">PRODUCT REFERENCE</span>
        <h2 id="catalog-title">Product catalog</h2>
        <p>Maintain the products suggested when a production task is created. Existing tasks keep their saved product details.</p>
      </div>
      <button type="button" className="button primary" disabled={mutationLocked || hasConflict || adding} onClick={() => {
        setEditingId(null); setEditDraft(null); setAdding(true); setFeedback(null);
      }}><Plus size={16}/>Add product</button>
    </div>

    {hasConflict && <div className="catalog-notice" role="alert">
      <div><strong>The catalog changed in another session.</strong><span>Your open draft is preserved while you review the latest list.</span></div>
      <button type="button" className="text-link" onClick={() => {
        resolveConflict();
        setFeedback({ message: 'Latest catalog loaded. Your draft is still open; review it before saving.', error: false });
      }}>Review latest catalog</button>
    </div>}

    {adding && <CatalogForm
      id="catalog-add"
      title="Add catalog product"
      draft={addDraft}
      disabled={mutationLocked || hasConflict}
      submitLabel={busy && pending?.type === 'catalog.create' ? 'Saving…' : 'Add product'}
      onChange={setAddDraft}
      onCancel={() => { setAdding(false); setAddDraft(EMPTY_DRAFT); setPending(null); setFeedback(null); }}
      onSubmit={addProduct}
    />}

    <div className="catalog-toolbar">
      <label className="catalog-search"><span className="sr-only">Search product catalog</span><Search size={16}/><input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Search code or product name"/></label>
      <span>{filtered.length} {filtered.length === 1 ? 'product' : 'products'} · {state.catalog.filter(product => !product.active).length} inactive</span>
    </div>

    {visible.length ? <div className="catalog-table-wrap"><table className="catalog-table">
      <thead><tr><th scope="col">CODE</th><th scope="col">PRODUCT NAME</th><th scope="col">DEFAULT</th><th scope="col">STATUS</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{visible.map(product => <ProductRows
        key={product.id}
        product={product}
        editing={editingId === product.id}
        draft={editingId === product.id ? editDraft : null}
        disabled={mutationLocked || hasConflict}
        saving={busy && pending?.productId === product.id}
        onEdit={() => startEdit(product)}
        onDraftChange={setEditDraft}
        onCancelEdit={() => { setEditingId(null); setEditDraft(null); setPending(null); setFeedback(null); }}
        onSubmit={updateProduct}
        onSetActive={active => void setActive(product, active)}
      />)}</tbody>
    </table></div> : <div className="catalog-empty"><strong>No matching products</strong><span>{query ? 'Try another code or product name.' : 'Add the first product used by the production team.'}</span></div>}

    {pageCount > 1 && <nav className="catalog-pagination" aria-label="Product catalog pages">
      <button type="button" className="button secondary" disabled={safePage === 0 || mutationLocked} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button>
      <span>Page {safePage + 1} of {pageCount}</span>
      <button type="button" className="button secondary" disabled={safePage === pageCount - 1 || mutationLocked} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))}>Next</button>
    </nav>}

    {feedback && <p className={'catalog-feedback' + (feedback.error ? ' error' : '')} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {storageMode === 'database' && storageWarning && pending && <div className="catalog-retry"><button type="button" className="text-link" disabled={busy} onClick={() => void refresh()}>Retry connection</button><span>The draft will close only after this catalog change is confirmed.</span></div>}
    {editingId && !editingProduct && <p className="catalog-feedback error" role="alert">This product is no longer in the latest catalog. Cancel this draft and review the latest list.</p>}
  </section>;
}

function CatalogForm({ id, title, draft, disabled, submitLabel, onChange, onCancel, onSubmit }: {
  id: string;
  title: string;
  draft: CatalogDraft;
  disabled: boolean;
  submitLabel: string;
  onChange: (draft: CatalogDraft) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return <form className="catalog-form" aria-labelledby={`${id}-title`} onSubmit={onSubmit}>
    <div className="catalog-form-title"><strong id={`${id}-title`}>{title}</strong><button type="button" className="icon-button" disabled={disabled} onClick={onCancel} aria-label={`Cancel ${title.toLocaleLowerCase()}`}><X size={17}/></button></div>
    <fieldset disabled={disabled}>
      <label className="field">Product code <span className="required">*</span><input autoFocus required maxLength={80} value={draft.code} onChange={event => onChange({ ...draft, code: event.target.value })}/></label>
      <label className="field catalog-name-field">Product name / description <span className="required">*</span><input required maxLength={200} value={draft.description} onChange={event => onChange({ ...draft, description: event.target.value })}/></label>
      <label className="field">Default delivery<select value={draft.defaultMode} onChange={event => onChange({ ...draft, defaultMode: event.target.value as QuantityMode })}><option value="bags">Bags</option><option value="bulk">Bulk</option></select></label>
    </fieldset>
    <div className="catalog-form-actions"><button type="button" className="button secondary" disabled={disabled} onClick={onCancel}>Cancel</button><button type="submit" className="button primary" disabled={disabled}><Save size={15}/>{submitLabel}</button></div>
  </form>;
}

function ProductRows({ product, editing, draft, disabled, saving, onEdit, onDraftChange, onCancelEdit, onSubmit, onSetActive }: {
  product: CatalogProduct;
  editing: boolean;
  draft: CatalogDraft | null;
  disabled: boolean;
  saving: boolean;
  onEdit: () => void;
  onDraftChange: (draft: CatalogDraft | null) => void;
  onCancelEdit: () => void;
  onSubmit: (event: React.FormEvent) => void;
  onSetActive: (active: boolean) => void;
}) {
  return <>
    <tr className={product.active ? '' : 'inactive'}>
      <td><strong>{product.code}</strong></td>
      <td>{product.description}</td>
      <td><span className="catalog-mode">{product.defaultMode === 'bags' ? 'Bags' : 'Bulk'}</span></td>
      <td><span className={'catalog-status ' + (product.active ? 'active' : 'inactive')}>{product.active ? 'Active' : 'Inactive'}</span></td>
      <td><div className="catalog-row-actions"><button type="button" className="icon-button" disabled={disabled || editing} onClick={onEdit} aria-label={`Edit ${product.code}`}><Pencil size={15}/></button><button type="button" className="icon-button" disabled={disabled} onClick={() => onSetActive(!product.active)} aria-label={`${product.active ? 'Deactivate' : 'Reactivate'} ${product.code}`} title={product.active ? 'Deactivate product' : 'Reactivate product'}>{product.active ? <Archive size={15}/> : <RotateCcw size={15}/>}</button></div></td>
    </tr>
    {editing && draft && <tr className="catalog-edit-row"><td colSpan={5}><CatalogForm id={`catalog-edit-${product.id}`} title={`Edit ${product.code}`} draft={draft} disabled={disabled} submitLabel={saving ? 'Saving…' : 'Save product'} onChange={value => onDraftChange(value)} onCancel={onCancelEdit} onSubmit={onSubmit}/></td></tr>}
  </>;
}
