import { readFileSync } from 'fs';
const SP='/tmp/claude-0/-home-user-claude-trading/f45495e6-7cc2-5923-bddf-957cb672bc25/scratchpad';
const FILES=[['SHY','shy.json'],['SLV','SLV.json'],['QQQ','QQQ.json'],['SMH','SMH.json'],
             ['TLT','TLT.json'],['XLE','XLE.json'],['SPY','spy.json'],['EEM','EEM.json'],
             ['GLD','GLD.json'],['VXX','VXX.json'],['SPCX','spcx.json']];

const key=(iso,p)=>p==='month'?iso.slice(0,7):p==='week'
  ?(d=>{d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);})(new Date(iso+'T00:00:00Z'))
  :iso;

// classic floor-trader pivots from the prior period, as shipped
function pivotsAt(s,i,period){
  const cur=key(s.t[i],period);
  let hi=-1e9,lo=1e9,close=null,k=null;
  for(let j=i;j>=0;j--){
    const kk=key(s.t[j],period);
    if(kk===cur) continue;
    if(k===null){k=kk;close=s.c[j];}
    else if(kk!==k) break;
    hi=Math.max(hi,s.h[j]); lo=Math.min(lo,s.l[j]);
  }
  if(k===null||hi<-1e8) return null;
  const p=(hi+lo+close)/3;
  return [2*p-lo, p+(hi-lo), hi+2*(p-lo), 2*p-hi, p-(hi-lo), lo-2*(hi-p)];
}

// swing highs/lows: a bar whose high (low) is the extreme of +/-k bars
function swingsAt(s,i,k=3,want=6){
  const out=[];
  for(let j=i-k-1;j>=Math.max(k,i-260);j--){
    let isH=true,isL=true;
    for(let d=-k;d<=k;d++){ if(d===0)continue;
      if(s.h[j+d]>=s.h[j])isH=false; if(s.l[j+d]<=s.l[j])isL=false; }
    if(isH) out.push(s.h[j]);
    if(isL) out.push(s.l[j]);
    if(out.length>=want) break;
  }
  return out.length?out:null;
}

// ATR for the tolerance band
function atrAt(s,i,len=14){
  let a=0;
  for(let j=i-len+1;j<=i;j++)
    a+=Math.max(s.h[j]-s.l[j],Math.abs(s.h[j]-s.c[j-1]),Math.abs(s.l[j]-s.c[j-1]));
  return a/len;
}

/* A level is TOUCHED when the day's range contains it. It HELD if, over the
   next 3 sessions, price never closed through it by more than 0.25 ATR.
   Random levels are drawn from the same day's plausible band, so the baseline
   faces identical volatility — the only difference is where the line sits. */
function run(pick,label){
  let touched=0, held=0;
  let seed=11; const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
  for(const [sym,f] of FILES){
    const s=JSON.parse(readFileSync(`${SP}/${f}`,'utf8')).series;
    const n=s.c.length;
    for(let i=300;i<n-4;i++){
      const lv=pick(s,i,rnd); if(!lv) continue;
      const atr=atrAt(s,i); if(!(atr>0)) continue;
      for(const L of lv){
        if(!(s.l[i]<=L&&L<=s.h[i])) continue;
        touched++;
        const above=s.c[i]>=L;
        let broke=false;
        for(let d=1;d<=3;d++){
          if(above ? s.c[i+d] < L-0.25*atr : s.c[i+d] > L+0.25*atr){broke=true;break;}
        }
        if(!broke) held++;
      }
    }
  }
  console.log(label.padEnd(26),'touches',String(touched).padStart(6),' held',(100*held/touched).toFixed(1)+'%');
  return held/touched;
}

console.log('Does price respect these levels? held = did NOT close through within 3 days');
console.log('');
const pv = run((s,i)=>pivotsAt(s,i,'month'),'classic pivots (monthly)');
run((s,i)=>pivotsAt(s,i,'week'),'classic pivots (weekly)');
run((s,i)=>pivotsAt(s,i,'day'),'classic pivots (daily)');
const sw = run((s,i)=>swingsAt(s,i),'prior swing highs/lows');
const rd = run((s,i,rnd)=>{ const lo=s.l[i],hi=s.h[i]; return [0,1,2,3,4,5].map(()=>lo+rnd()*(hi-lo)); },'RANDOM baseline');
console.log('');
console.log('swing vs random :', ((sw-rd)*100).toFixed(1)+' pts');
console.log('pivots vs random:', ((pv-rd)*100).toFixed(1)+' pts');
