// Static inline script (no interpolation) run in <head> before first paint.
// Adds class "lite" to <html> on weak devices or when the user chose Lite.
// localStorage['ft-lite']: '1' = force lite, '0' = force full, absent = auto.
export const FT_LITE_SCRIPT = `(function(){try{
var d=document.documentElement,s=null,q=null;
try{q=/[?&]lite=([01])(?:&|$)/.exec(location.search);}catch(e){}
try{
if(q){localStorage.setItem('ft-lite',q[1]);s=q[1];}
else{s=localStorage.getItem('ft-lite');}
}catch(e){if(q){s=q[1];}}
var lite=false;
if(s==='1'){lite=true;}
else if(s!=='0'){
var n=navigator,dm=n.deviceMemory,hc=n.hardwareConcurrency;
if(typeof dm==='number'&&dm<=2){lite=true;}
else if(typeof dm==='number'&&typeof hc==='number'&&hc<=4&&dm<=4){lite=true;}
else if(n.connection&&n.connection.saveData){lite=true;}
else{try{if(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-data: reduce)').matches){lite=true;}}catch(e){}}
}
if(lite){d.classList.add('lite');}
}catch(e){}})();`

/** Client-side mirror of the auto-detection rule in FT_LITE_SCRIPT (used by the Auto option). */
export function detectAutoLite(): boolean {
    try {
        const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
        const dm = n.deviceMemory
        const hc = n.hardwareConcurrency
        if (typeof dm === 'number' && dm <= 2) return true
        if (typeof dm === 'number' && typeof hc === 'number' && hc <= 4 && dm <= 4) return true
        if (n.connection?.saveData) return true
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-data: reduce)').matches
    } catch {
        return false
    }
}
