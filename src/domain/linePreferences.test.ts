import {describe,it,expect} from 'vitest';
import {createDefaultLinePreferences,exactFsCode,preferredLinesForProduct,validateLinePreferences} from './linePreferences';
import {createDefaultSettings} from './defaults';
import {validateSettingsUpdate} from './backup';

describe('exact product line preferences',()=>{
  it('keeps complete FS suffix and packaging distinct from SAP material identifiers',()=>{
    const settings=createDefaultSettings();
    const product=(description:string,unit:'Bags'|'MT'='Bags')=>({description,unit,materialCode:'7.0312008522000'});
    expect(preferredLinesForProduct(settings,product('FS 5220M FICTIONAL 50KG'))).toEqual(['PM1']);
    expect(preferredLinesForProduct(settings,product('FS 5220MER FICTIONAL 50KG'))).toEqual(['PM3']);
    expect(preferredLinesForProduct(settings,product('FS 5220 FICTIONAL BULK','MT'))).toEqual(['PM1','PM4']);
    expect(preferredLinesForProduct(settings,product('FS 5210 FICTIONAL 25KG'))).toEqual(['PM2','PM3']);
    expect(preferredLinesForProduct(settings,product('FS 5210 FICTIONAL BULK','MT'))).toEqual(['PM2']);
    expect(exactFsCode(product('No FS code'))).toBeNull();
  });
  it('validates duplicates case-insensitively and rejects missing or unknown PMs',()=>{
    const prefs=createDefaultLinePreferences();
    expect(()=>validateLinePreferences({...prefs,rules:[prefs.rules[0],{...prefs.rules[0],fsCode:'5220'}]})).toThrow(/duplicate/);
    expect(()=>validateLinePreferences({...prefs,defaultPreferredLines:[]})).toThrow();
    expect(()=>validateLinePreferences({...prefs,defaultPreferredLines:['PM5']})).toThrow();
    expect(()=>validateLinePreferences({...prefs,rules:[{fsCode:'7.0312008522000',packaging:'Bags',preferredLines:['PM1']}]})).toThrow();
    expect(validateLinePreferences({...prefs,rules:[{fsCode:'5220m',packaging:'Bags',preferredLines:['PM4','PM1']}]}).rules[0]).toEqual({fsCode:'5220M',packaging:'Bags',preferredLines:['PM1','PM4']});
  });
  it('persists editable defaults and can disable routing without changing production settings',()=>{
    const settings=createDefaultSettings();settings.linePreferences={enabled:false,rules:[],defaultPreferredLines:['PM4']};
    expect(validateSettingsUpdate(settings).linePreferences).toEqual(settings.linePreferences);
    expect(preferredLinesForProduct(settings,{description:'FS 5220 FICTIONAL',unit:'Bags'})).toEqual(['PM1','PM2','PM3','PM4']);
  });
});
