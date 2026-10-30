import { packagingLabel, productLabel } from '../lib/productLabel';
import './ProductIdentity.css';

export function ProductIdentity({materialCode, description = '', unit, bagWeightKg}: {
  materialCode: string; description?: string; unit: 'Bags' | 'MT'; bagWeightKg?: number | null;
}) {
  const packaging = packagingLabel({unit,bagWeightKg,description});
  return <div className="product-identity">
    <strong className="product-identity-title">{productLabel({materialCode, description})}<span> · {packaging}</span></strong>
    {description && <small className="product-identity-description">{description}</small>}
    <small className="product-identity-material">SAP {materialCode}</small>
  </div>;
}
