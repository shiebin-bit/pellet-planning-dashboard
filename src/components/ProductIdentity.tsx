import { packagingLabel, productLabel } from '../lib/productLabel';
import { ChevronDown } from 'lucide-react';
import './ProductIdentity.css';

export function ProductIdentity({materialCode, description = '', unit, bagWeightKg, variant = 'full'}: {
  materialCode: string; description?: string; unit: 'Bags' | 'MT'; bagWeightKg?: number | null; variant?: 'full' | 'compact';
}) {
  const packaging = packagingLabel({unit,bagWeightKg,description});
  const label = productLabel({materialCode, description});
  if (variant === 'compact') return <div className="product-identity compact-product">
    <strong className="product-identity-title">{label}<span> · {packaging}</span></strong>
    <details className="product-identity-details">
      <summary aria-label={`Product details for ${label}, SAP ${materialCode}`}><span title={description || materialCode}>{description || 'View product details'}</span><ChevronDown size={13}/></summary>
      <div>{description && <p className="product-identity-description">{description}</p>}<small className="product-identity-material">SAP {materialCode}</small></div>
    </details>
  </div>;
  return <div className="product-identity">
    <strong className="product-identity-title">{productLabel({materialCode, description})}<span> · {packaging}</span></strong>
    {description && <small className="product-identity-description">{description}</small>}
    <small className="product-identity-material">SAP {materialCode}</small>
  </div>;
}
