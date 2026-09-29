/* Search the historical-high/low family properly, against the same matched
 * null the pivots were measured with. */
const SYMBOLS=['SHY','SLV','QQQ','SMH','TLT','XLE','SPY','EEM','GLD','VXX'];
const PROXY='https://kwugzhyfjevzwgplhtsd.supabase.co/functions/v1/quote-proxy';
const ANON='sb_publishable_5SCxDQzd0D7aEbbgG3C_3w_4cvGNP0E';
async function bars(sym){
  const r=await fetch(PROXY,{method:'POST',headers:{'content-type':'application/json',apikey:ANON,
    authorization:`Bearer ${ANON}`,origin:'https://akyachtsman.github.io'},
    body:JSON.stringify({symbol:sym,kind:'daily'})});
  const j=await r.json(); if(!j.ok) throw new Error(sym); return j.series;
}
const atr=(s,i,len=14)=>{let a=0;for(let j=i-len+1;j<=i;j++)
  a+=Math.max(s.h[j]-s.l[j],Math.abs(s.h[j]-s.c[j-1]),Math.abs(s.l[j]-s.c[j-1]));return a/len;};

/* raw swing pivots within `look` bars, k bars either side */
function rawSwings(s,i,k,look){
  const out=[];
  for(let j=i-k-1;j>=Math.max(k,i-look);j--){
    let isH=true,isL=true;
    for(let d=-k;d<=k;d++){if(!d)continue;
      if(s.h[j+d]>=s.h[j])isH=false; if(s.l[j+d]<=s.l[j])isL=false;}
    if(isH)out.push({v:s.h[j],role:'R'});
    if(isL)out.push({v:s.l[j],role:'S'});
  }
  return out;
}
/* merge swings that sit within tol*ATR of each other; a cluster's size is how
   many separate turns confirm that price. Keep clusters with >= minTouch. */
function cluster(list,tol,minTouch,a){
  if(!tol) return minTouch>1?[]:list;
  const out=[];
  for(const p of list){
    const hit=out.find(o=>o.role===p.role&&Math.abs(o.v-p.v)<=tol*a);
    if(hit){hit.n++; hit.v=(hit.v*(hit.n-1)+p.v)/hit.n;} else out.push({...p,n:1});
  }
  return out.filter(o=>o.n>=minTouch);
}
/* EXACTLY what swingLevels() in scripts/app.js ships: resistances above price
   and supports below it, nearest first, three a side. Codex review on PR #247
   caught the first cut taking the six nearest clusters globally regardless of
   side — that scored a level set the UI never draws, so its ranking could not
   validate the shipped construction. */
const production=(list,px)=>[
  ...list.filter(g=>g.role==='R'&&g.v>px).sort((a,b)=>a.v-b.v).slice(0,3),
  ...list.filter(g=>g.role==='S'&&g.v<px).sort((a,b)=>b.v-a.v).slice(0,3),
];

const periodKey=(iso,p)=>p==='month'?iso.slice(0,7):iso;
function pivots(s,i,period){
  const cur=periodKey(s.t[i],period);
  let hi=-Infinity,lo=Infinity,close=null,k=null;
  for(let j=i;j>=0;j--){const kk=periodKey(s.t[j],period);
    if(kk===cur)continue; if(k===null){k=kk;close=s.c[j];} else if(kk!==k)break;
    hi=Math.max(hi,s.h[j]);lo=Math.min(lo,s.l[j]);}
  if(k===null||!Number.isFinite(hi))return null;
  const p=(hi+lo+close)/3;
  return [{v:2*p-lo,role:'R'},{v:p+(hi-lo),role:'R'},{v:hi+2*(p-lo),role:'R'},
          {v:2*p-hi,role:'S'},{v:p-(hi-lo),role:'S'},{v:lo-2*(hi-p),role:'S'}];
}
const held=(s,i,lv,h,tol,a)=>{for(let d=1;d<=h;d++){
  if(lv.role==='R'? s.c[i+d]>lv.v+tol*a : s.c[i+d]<lv.v-tol*a) return false;} return true;};

let seed=11; const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
function score(data,pick){
  let n=0,ok=0,nn=0,nok=0;
  for(const h of [1,3,5]) for(const tol of [0.10,0.25,0.50]){
    for(const s of data){
      for(let i=300;i<s.c.length-h-1;i++){
        const a=atr(s,i); if(!(a>0))continue;
        const lv=pick(s,i,a); if(!lv||!lv.length)continue;
        for(const L of lv){
          if(!(s.l[i]<=L.v&&L.v<=s.h[i]))continue;
          n++; if(held(s,i,L,h,tol,a))ok++;
          const r={v:s.l[i]+rnd()*(s.h[i]-s.l[i]),role:L.role};
          nn++; if(held(s,i,r,h,tol,a))nok++;
        }
      }
    }
  }
  return {n,edge:(ok/n-nok/nn)*100};
}
const data=[]; for(const s of SYMBOLS){try{data.push(await bars(s));}catch{}}
console.log(`loaded ${data.length} symbols — edge is averaged over all 9 horizon/tolerance cells\n`);
const rows=[];
/* Pivots BOTH ways. The shipped pivot model draws all six regardless of where
   price sits, while swingLevels() keeps only levels still ahead of the market.
   Comparing them directly would measure that filter rather than the level
   source — a "resistance" already below price breaks on contact by
   definition. The side-filtered pivot row isolates the variable. */
const sideFilter=(list,px)=>[
  ...list.filter(g=>g.role==='R'&&g.v>px).sort((a,b)=>a.v-b.v),
  ...list.filter(g=>g.role==='S'&&g.v<px).sort((a,b)=>b.v-a.v),
];
rows.push(['pivots daily (shipped, all 6)',score(data,(s,i)=>pivots(s,i,'day'))]);
rows.push(['pivots daily SIDE-FILTERED',score(data,(s,i)=>sideFilter(pivots(s,i,'day')||[],s.c[i]))]);
rows.push(['pivots monthly SIDE-FILTERED',score(data,(s,i)=>sideFilter(pivots(s,i,'month')||[],s.c[i]))]);
rows.push(['pivots monthly (all 6)',score(data,(s,i)=>pivots(s,i,'month'))]);
for(const k of [2,3,5,8]) for(const [tol,mt] of [[0,1],[0.25,1],[0.5,1],[0.25,2],[0.5,2]]){
  const label=`swing k=${k} cluster=${tol||'none'}${mt>1?' min'+mt:''}`;
  rows.push([label,score(data,(s,i,a)=>production(cluster(rawSwings(s,i,k,260),tol,mt,a),s.c[i]))]);
}
rows.sort((a,b)=>b[1].edge-a[1].edge);
console.log('construction                        touches     edge');
for(const [l,r] of rows) console.log(l.padEnd(35),String(r.n).padStart(7),(r.edge>=0?'+':'')+r.edge.toFixed(2)+' pts');
