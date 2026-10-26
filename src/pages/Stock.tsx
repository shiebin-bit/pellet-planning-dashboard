import { useRef } from 'react';
import { Upload } from 'lucide-react';
import { AutoPlanningButton } from '../components/InventoryDraftDialog';
import { DailyStockBrowser, StockBrowser } from '../components/InventoryWorkspace';
import { useWorkspace } from '../lib/workspace';
import './Data.css';
import { useListState } from '../lib/listNavigation';

const tabs = [
  { id: 'stock', label: 'Stock' },
  { id: 'daily', label: 'Daily stock' },
] as const;

export function StockPage() {
  const { storageMode, openImport, mutationLocked, hasConflict } = useWorkspace();
  const [tab, setTab] = useListState<'stock' | 'daily'>('stock.tab','stock');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  return <div className="page data-page stock-page">
    <div className="page-heading">
      <div><h1>Stock</h1><p>Review finished-goods balances, stock policies and daily movements.</p></div>
      <div className="inventory-toolbar">
        <AutoPlanningButton/>
        <button className="button primary" disabled={storageMode !== 'database' || mutationLocked || hasConflict} onClick={openImport}><Upload size={16}/>Import Excel</button>
      </div>
    </div>
    {storageMode === 'database' ? <>
      <div className="inventory-tabs" role="tablist" aria-label="Stock sections">
        {tabs.map(({ id, label }, index) => <button key={id} ref={element => { tabRefs.current[index] = element; }}
          id={`stock-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`stock-panel-${id}`} tabIndex={tab === id ? 0 : -1}
          onClick={() => setTab(id)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            setTab(tabs[next].id);
            tabRefs.current[next]?.focus();
          }}>{label}</button>)}
      </div>
      <div role="tabpanel" id={`stock-panel-${tab}`} aria-labelledby={`stock-tab-${tab}`} tabIndex={0}>
        {tab === 'stock' ? <StockBrowser/> : <DailyStockBrowser/>}
      </div>
    </> : <div className="notice warning">Stock requires the PostgreSQL workspace. Manual planning remains available offline.</div>}
  </div>;
}
