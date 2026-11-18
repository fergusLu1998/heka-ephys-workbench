/* Pure numerical helpers. CommonJS export also supports reproducible Node checks. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EphysMath = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function parseNpy(buffer, expected) {
    const b = new Uint8Array(buffer), dv = new DataView(buffer);
    if (b[0] !== 147 || String.fromCharCode(...b.slice(1,6)) !== 'NUMPY') throw Error('Invalid NPY data');
    const v=b[6], headStart=v===1 ? 10 : 12;
    const header=new TextDecoder().decode(b.slice(headStart,headStart+(v===1?dv.getUint16(8,true):dv.getUint32(8,true))));
    if (!/['"]descr['"]\s*:\s*['"]<f8['"]/.test(header) || !/['"]fortran_order['"]\s*:\s*False/.test(header)) throw Error('Unsupported NPY encoding');
    const match=header.match(/['"]shape['"]\s*:\s*\(\s*(\d+)\s*,?\s*\)/);
    if (!match || +match[1]!==expected) throw Error('Raw sample count mismatch');
    const offset=headStart+(v===1?dv.getUint16(8,true):dv.getUint32(8,true));
    if (buffer.byteLength!==offset+expected*8) throw Error('Truncated raw trace');
    return new Float64Array(buffer,offset,expected);
  }
  function coordinates(s, n) {
    const times=new Float64Array(n), volts=new Float64Array(n);
    times.fill(NaN); volts.fill(NaN);
    for (const seg of s.segments) {
      if (!seg.stored) continue;
      for (let i=seg.sample_start; i<Math.min(n,seg.sample_end); i++) {
        times[i]=seg.start_s+(i-seg.sample_start)*s.dt_s;
        if (!s.is_leak) volts[i]=seg.voltage_mV;
      }
    }
    return {times,volts};
  }
  function valueTransform(y,mode,metrics) {
    if (mode==='raw') return y;
    const b=metrics.baseline_current_pA, d=metrics.activation_change_pA;
    if (b==null || !Number.isFinite(b)) return null;
    if (mode==='baseline') return y-b;
    return d!=null && Number.isFinite(d) && Math.abs(d)>1e-9 ? (y-b)/Math.abs(d) : null;
  }
  function statistics(y,s,cursor,mode='raw',only=null) {
    if(only!==null&&!['min','max','mean'].includes(only)) throw Error('Unknown cursor statistic');
    let count=0, sum=0, compensation=0, min=Infinity, max=-Infinity, minTime=null, maxTime=null,firstTime=null,lastTime=null;
    let start=Number(cursor.start), end=Number(cursor.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end<start) throw Error('Cursor start/end is invalid');
    const point=cursor.type==='point';
    for (const seg of s.segments) {
      if (!seg.stored || seg.sample_start>=y.length) continue;
      let lo,hi;
      if (point) {
        const actualEnd=seg.start_s+(Math.min(y.length,seg.sample_end)-seg.sample_start)*s.dt_s;
        if (start<seg.start_s-1e-12 || start>=actualEnd-1e-12) continue;
        lo=Math.min(Math.min(y.length,seg.sample_end)-1,seg.sample_start+Math.round((start-seg.start_s)/s.dt_s)); hi=lo+1;
      } else {
        lo=Math.max(seg.sample_start,seg.sample_start+Math.ceil((start-seg.start_s)/s.dt_s-1e-8));
        hi=Math.min(y.length,seg.sample_end,seg.sample_start+Math.ceil((end-seg.start_s)/s.dt_s-1e-8));
      }
      for (let i=lo;i<hi;i++) {
        const v=valueTransform(y[i],mode,s.metrics); if (v==null || !Number.isFinite(v)) continue;
        const t=seg.start_s+(i-seg.sample_start)*s.dt_s;
        if (!count) firstTime=t; lastTime=t; count++;
        if(only===null||only==='mean'){const corrected=v-compensation, total=sum+corrected; compensation=(total-sum)-corrected; sum=total;}
        if((only===null||only==='min')&&v<min){min=v;minTime=t;}
        if((only===null||only==='max')&&v>max){max=v;maxTime=t;}
      }
    }
    if(only!==null)return {n:count,statistic:only,value:count?(only==='min'?min:only==='max'?max:sum/count):null,value_time_s:only==='min'?minTime:only==='max'?maxTime:point?firstTime:null,first_sample_s:firstTime,last_sample_s:lastTime,status:count?'OK':'NO_STORED_SAMPLES'};
    return {n:count,min:count?min:null,max:count?max:null,mean:count?sum/count:null,min_time_s:minTime,max_time_s:maxTime,first_sample_s:firstTime,last_sample_s:lastTime,status:count?'OK':'NO_STORED_SAMPLES'};
  }
  function csvCell(value) {
    if (value==null || (typeof value==='number' && !Number.isFinite(value))) return '';
    const s=String(value); return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
  }
  function csv(rows,keys) { return [keys.join(','),...rows.map(row=>keys.map(k=>csvCell(row[k])).join(','))].join('\r\n'); }
  function parseQuick(text,series,traceForSeries,currentLabel,getSweeps) {
    const ids=[],errors=[];
    for (const token of text.trim().split(/[,，;；\s]+/).filter(Boolean)) {
      const m=/^S(\d+)W(\d+)(?:T(\d+))?$/i.exec(token);
      if (!m){errors.push(token+' 格式无效');continue;}
      const sr=series.find(s=>s.series_index===+m[1]);
      const channels=sr ? traceForSeries(sr.series_id) : [];
      const channel=m[3] ? channels.find(t=>t.trace_index===+m[3]) : channels.find(t=>t.trace_label===currentLabel);
      const sw=channel ? getSweeps(channel.trace_id).find(s=>s.sweep_index===+m[2]) : null;
      if(!sw) errors.push(token+' 找不到对应 Series / sweep / 同名通道，可用 T1、T2 指定');
      else if(!ids.includes(sw.sweep_id)) ids.push(sw.sweep_id);
    }
    if (!ids.length&&!errors.length) errors.push('请输入 S01W2,S06W10');
    return {ids,errors};
  }
  function niceScale(span) { const target=Math.max(Math.abs(span)/5,1e-9), p=10**Math.floor(Math.log10(target)); return [1,2,5,10].map(v=>v*p).filter(v=>v<=target).pop()||p; }
  function recovery(y,s,c){
    const start=Number(c.start),end=Number(c.end),percent=Number(c.tolerance_pct??5),hold=Number(c.hold_ms??1)/1000;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||!Number.isFinite(percent)||percent<0||percent>=100||!Number.isFinite(hold)||hold<0)throw Error('恢复时间窗口、容差或持续时间无效');
    const baselineMode=c.baseline_mode||'auto',rule=c.recovery_rule||'band';
    let baseline=baselineMode==='manual'?c.baseline_pA:s.metrics.baseline_current_pA;
    if(baselineMode==='window')baseline=statistics(y,s,{type:'window',start:c.baseline_start,end:c.baseline_end},'raw','mean').value;
    const co=coordinates(s,y.length),samples=[];let peak=null;
    for(let i=0;i<y.length;i++)if(co.times[i]>=start-1e-12&&co.times[i]<end-1e-12){const p={t:co.times[i],v:y[i]};samples.push(p);if(Number.isFinite(p.v)&&(!peak||p.v<peak.v))peak={...p,index:samples.length-1};}
    const result={n:samples.filter(p=>Number.isFinite(p.v)).length,statistic:'recovery_time',value:null,value_time_s:null,unit:'ms',basis:'raw',first_sample_s:samples[0]?.t??null,last_sample_s:samples.at(-1)?.t??null,baseline_mode:baselineMode,baseline_pA:Number.isFinite(baseline)?baseline:null,baseline_start_s:baselineMode==='window'?c.baseline_start:null,baseline_end_s:baselineMode==='window'?c.baseline_end:null,peak_current_pA:peak?.v??null,peak_time_s:peak?.t??null,recovery_rule:rule,tolerance_pct:rule==='band'?percent:0,tolerance_pA:null,hold_ms:rule==='band'?hold*1000:0,recovery_time_s:null,recovery_at_s:null,confirmation_at_s:null,status:'NO_STORED_SAMPLES'};
    if(!peak)return result;
    if(!Number.isFinite(baseline))return {...result,status:'NO_BASELINE'};
    if(peak.v>=baseline)return {...result,status:'NO_NEGATIVE_PEAK'};
    const tolerance=(baseline-peak.v)*percent/100;result.tolerance_pA=rule==='band'?tolerance:0;
    let entered=null,previous=peak.t;
    for(let i=peak.index+1;i<samples.length;i++){
      const p=samples[i];if(!Number.isFinite(p.v)||p.t-previous>s.dt_s*1.5)return {...result,status:'GAP_BEFORE_RECOVERY'};previous=p.t;
      const inside=rule==='cross'?p.v>=baseline:Math.abs(p.v-baseline)<=tolerance+1e-12;
      if(!inside){entered=null;continue;}if(entered===null)entered=p.t;
      if(rule==='cross'||p.t-entered>=hold-1e-12)return {...result,value:(entered-peak.t)*1000,value_time_s:entered,recovery_time_s:entered-peak.t,recovery_at_s:entered,confirmation_at_s:p.t,status:'OK'};
    }
    return {...result,status:'NOT_RECOVERED_WITHIN_WINDOW'};
  }
  const measure=(y,s,cursor,mode='raw')=>cursor.type==='recovery'?recovery(y,s,cursor):statistics(y,s,cursor,mode,cursor.statistic||'mean');
  const csvColumns=rows=>[...new Set(rows.flatMap(r=>Object.keys(r)))];
  function trendX(row,key){
    if(key==='recorded')return typeof row.sweep_recorded_at==='string'&&Number.isFinite(Date.parse(row.sweep_recorded_at))?row.sweep_recorded_at:null;
    const value=key==='order'?row.group_sweep_index:row.group_elapsed_s;
    return typeof value==='number'&&Number.isFinite(value)?value/(key==='elapsed_min'?60:1):null;
  }
  function trendCurves(rows,key='elapsed_min',scale=1){
    const groups=new Map();
    for(const r of rows){const id=JSON.stringify([r.cursor_id,r.trace_label,r.trace_index,r.protocol_name]);
      if(!groups.has(id))groups.set(id,{key:id,cursor_id:r.cursor_id,cursor_name:r.cursor_name,statistic:r.statistic,unit:r.unit||'pA',trace_label:r.trace_label,trace_index:r.trace_index,protocol_name:r.protocol_name,rows:[]});
      groups.get(id).rows.push(r);
    }
    for(const curve of groups.values()){
      curve.rows.sort((a,b)=>(a.group_elapsed_s??Infinity)-(b.group_elapsed_s??Infinity)||a.group_sweep_index-b.group_sweep_index);
      curve.points=curve.rows.map(r=>({row:r,x:trendX(r,key),y:typeof r.value==='number'&&Number.isFinite(r.value)?r.value*(r.unit==='ms'?1:scale):null}));
      curve.x=[];curve.y=[];curve.hoverRows=[];let previous=null;
      for(const point of curve.points){
        if(previous&&previous!==point.row.series_id){curve.x.push(null);curve.y.push(null);curve.hoverRows.push(null);}
        curve.x.push(point.x);curve.y.push(point.x===null?null:point.y);curve.hoverRows.push(point.row);previous=point.row.series_id;
      }
    }return Array.from(groups.values());
  }
  function trendRange(lowText,highText,values,date=false){
    const low=String(lowText).trim(),high=String(highText).trim();if(!low&&!high)return undefined;
    const number=v=>date?Date.parse(String(v).replace(' ','T')+'Z'):Number(v);
    const valid=values.filter(v=>v!==null&&v!==undefined&&Number.isFinite(number(v))).sort((a,b)=>number(a)-number(b));
    const a=low||valid[0],b=high||valid.at(-1);
    if(a===undefined||b===undefined||!Number.isFinite(number(a))||!Number.isFinite(number(b)))throw Error(date?'时间范围请填写 YYYY-MM-DD HH:mm:ss':'坐标范围须为有效数值');
    if(number(a)>=number(b))throw Error('坐标下限必须小于上限');
    return date?[String(a).replace('T',' '),String(b).replace('T',' ')]:[Number(a),Number(b)];
  }
  return {parseNpy,coordinates,valueTransform,statistics,recovery,measure,csvCell,csv,csvColumns,parseQuick,niceScale,trendX,trendCurves,trendRange};
});
