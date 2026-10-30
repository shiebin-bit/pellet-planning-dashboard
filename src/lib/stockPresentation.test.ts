import {describe,expect,it} from 'vitest';
import {replenishmentShortage} from './stockPresentation';
import type {InventoryItemConfiguration} from '../domain/inventoryTypes';

const item:InventoryItemConfiguration={itemId:'qa',materialCode:'qa',description:'Fictional feed',unit:'Bags',bagWeightKg:50,strategy:'mts',targetQuantity:20,defaultExtra:null,needsReview:false};
const bucket={medication:'',fmrOmed:'',onHand:30,reserved:15,available:15};
describe('stock shortage presentation',()=>{
  it('shows the gap after reservations, with no shortage when stock meets the target',()=>{
    expect(replenishmentShortage(item,bucket)).toBe(5);
    expect(replenishmentShortage(item,{...bucket,available:20})).toBe(0);
    expect(replenishmentShortage(item,{...bucket,available:30})).toBe(0);
  });
  it('does not apply standard safety stock to MTO, missing targets or Medication/FMR variants',()=>{
    expect(replenishmentShortage({...item,strategy:'mto'},bucket)).toBeNull();
    expect(replenishmentShortage({...item,targetQuantity:null},bucket)).toBeNull();
    expect(replenishmentShortage(item,{...bucket,medication:'QA medication'})).toBeNull();
    expect(replenishmentShortage(item,{...bucket,fmrOmed:'QA FMR'})).toBeNull();
  });
  it('retains a 0.001 MT shortage without binary floating-point noise',()=>{
    expect(replenishmentShortage({...item,unit:'MT',bagWeightKg:null},{...bucket,available:19.999})).toBe(0.001);
  });
});
