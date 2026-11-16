import {describe,expect,it} from 'vitest';
import {parseDailyImportCommand,parseDailyPreviewRequest} from './dailyImport';

const report=()=>({fileName:'fictional.xlsm',digest:'a'.repeat(64),sheetName:'26th',asOfDate:'2026-10-26',stockRows:[{materialCode:'TEST',description:'FS 5220 TEST',unit:'Bags',bagWeightKg:25,strategy:'mto',targetQuantity:0,needsReview:false,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:'',fmrOmed:''}],orderRows:[]});
describe('daily import boundary',()=>{
 it('rejects calendar rollover dates, repeated dates and unordered command batches',()=>{
  expect(()=>parseDailyPreviewRequest({reports:[{...report(),asOfDate:'2026-02-30'}]})).toThrow('valid');
  expect(()=>parseDailyPreviewRequest({reports:[report(),report()]})).toThrow('repeat');
  expect(()=>parseDailyImportCommand({type:'inventory.importDailyReports',reports:[{...report(),asOfDate:'2026-10-27'},report()],reconcile:false,reason:''})).toThrow('ascending');
 });
 it('keeps status controls constrained to audited actions and forbids client timestamps',()=>{
  expect(parseDailyImportCommand({type:'data.setPlanningControl',sourceOrderId:'test-order',action:'historicalOut',reason:'Verified count',stockAccounted:true})).toMatchObject({action:'historicalOut'});
  expect(()=>parseDailyImportCommand({type:'data.setPlanningControl',sourceOrderId:'test-order',action:'release',reason:'',updatedAt:'2026-10-26'})).toThrow('not supported');
  expect(()=>parseDailyImportCommand({type:'data.setPlanningControl',sourceOrderId:'test-order',action:'delete',reason:'Test'})).toThrow('invalid');
 });
});
