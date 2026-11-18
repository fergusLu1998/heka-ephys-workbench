'use strict';
const M=EphysMath, $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x,n=4)=>x==null||!Number.isFinite(Number(x))?'—':Number(x).toFixed(n);
const fileMap=new Map(DATA.files.map(s=>[s.file_id,s])), groupMap=new Map(DATA.groups.map(s=>[s.group_id,s]));
const seriesMap=new Map(DATA.series.map(s=>[s.series_id,s])), channelMap=new Map(DATA.traces.map(s=>[s.trace_id,s]));
const sweepMap=new Map(DATA.sweeps.map(s=>[s.sweep_id,s]));
const forGroup=id=>DATA.series.filter(s=>s.group_id===id).sort((a,b)=>a.series_index-b.series_index);
const channels=id=>DATA.traces.filter(s=>s.series_id===id).sort((a,b)=>a.trace_index-b.trace_index);
const sweeps=id=>DATA.sweeps.filter(s=>s.trace_id===id).sort((a,b)=>a.sweep_index-b.sweep_index);
const palette=['#0f4d92','#b64342','#42949e','#9a4d8e','#767676'];
const defaultDisplayMode='baseline';
const state={fileId:null,groupId:null,seriesId:null,traceId:null,mode:defaultDisplayMode,pool:[],selected:new Set(),cursors:[],cursorNumber:0,basis:'raw',rows:[],trendRows:[],trendHidden:new Set(),trendCurves:[],generation:0,readyGeneration:-1};
const workspace=EphysSession.create(localStorage);
let loadedGroup=null,pendingWorkspace=null,cursorInitialized=false,lastSavedCursors='';
const cursorSettings=()=>EphysSession.cleanCursors(state);
const fileKey=id=>fileMap.get(id)?.sha256||fileMap.get(id)?.relative_path||id;
const groupKey=id=>{const g=groupMap.get(id);return g?`${g.group_index}/${g.start_time}`:null;};
const sweepAddress=s=>`${seriesMap.get(s.series_id).series_index}/${s.sweep_index}/${channelMap.get(s.trace_id).trace_index}`;
function workspaceSnapshot(){
  const source=channelMap.get($('analysisTraceSelect').value),sw=sweepMap.get($('analysisSweepSelect').value),view={};
  for(const id of workspace.controls)view[id]=$(id).value;
  return {selected:visible().map(sweepAddress),cursors:state.cursors,cursorNumber:state.cursorNumber,series:seriesMap.get(state.seriesId)?.series_index,trace:channelMap.get(state.traceId)?.trace_index,sourceSeries:seriesMap.get(source?.series_id)?.series_index,sourceTrace:source?.trace_index,sourceSweep:sw?.sweep_index,view};
}
function saveWorkspace(){
  if(loadedGroup!==state.groupId||pendingWorkspace||!state.groupId)return;
  try{
    const settings=cursorSettings(),serialized=JSON.stringify(settings);
    workspace.save(fileKey(state.fileId),groupKey(state.groupId),workspaceSnapshot(),serialized!==lastSavedCursors?settings:null);
    lastSavedCursors=serialized;
  }catch(e){status('cursorSettingsStatus','自动保存失败：'+e.message,true);}
}
function loadGroupWorkspace(){
  if(loadedGroup===state.groupId)return;
  loadedGroup=state.groupId;pendingWorkspace=workspace.get(fileKey(state.fileId),groupKey(state.groupId));
  state.pool=groupSweeps(state.groupId).map(s=>s.sweep_id);const selected=new Set(pendingWorkspace?.selected||[]);
  state.selected=new Set(pendingWorkspace?groupSweeps(state.groupId).filter(s=>selected.has(sweepAddress(s))).map(s=>s.sweep_id):state.pool);
  $('displayMode').value=state.mode=defaultDisplayMode;
  const choices=forGroup(state.groupId).map(s=>[s.series_id,seriesCode(s)+' · '+s.protocol_name]);
  options('trendFocus',[['','全部 Series'],...choices],'');
  state.trendHidden.clear();
  state.seriesId=pendingWorkspace?forGroup(state.groupId).find(s=>s.series_index===pendingWorkspace.series)?.series_id:null;
  state.traceId=pendingWorkspace?channels(state.seriesId).find(t=>t.trace_index===pendingWorkspace.trace)?.trace_id:null;
}
function applyWorkspaceView(){
  const saved=pendingWorkspace;if(!saved)return;
  for(const [id,value] of Object.entries(saved.view)){const el=$(id);if(el&&(!el.options||Array.from(el.options).some(o=>o.value===value)))el.value=value;}
  state.mode=$('displayMode').value;state.basis=$('analysisBasis').value;
  const sid=forGroup(state.groupId).find(s=>s.series_index===saved.sourceSeries)?.series_id,tid=channels(sid).find(t=>t.trace_index===saved.sourceTrace)?.trace_id;
  if(tid){$('analysisTraceSelect').value=tid;populateSourceSweeps();const sw=sweeps(tid).find(s=>s.sweep_index===saved.sourceSweep);if(sw)$('analysisSweepSelect').value=sw.sweep_id;}
  pendingWorkspace=null;
}
function resumeWorkspace(){
  const settings=workspace.cursorSettings();
  if(settings){Object.assign(state,settings);cursorInitialized=true;}
  lastSavedCursors='';
  const file=DATA.files.find(f=>fileKey(f.file_id)===workspace.lastFile());if(file)state.fileId=file.file_id;
  loadedGroup=null;state.groupId=state.seriesId=state.traceId=null;populateFiles();renderAll();
}
let annotations={}; const annotationKey='heka-ephys-annotations-v1';
try{annotations=JSON.parse(localStorage.getItem(annotationKey)||'{}');}catch(_){/* Retain malformed stored data without overwriting it. */}
for(const s of DATA.sweeps){
  const t=channelMap.get(s.trace_id); s.dt_s=s.dt_s||t.sample_interval_s; s.is_leak=t.is_leak_trace;
  s.raw_url=s.raw_url||`trace_cache/${s.sweep_id}.npy`;
}
const visible=()=>state.pool.filter(id=>state.selected.has(id)).map(id=>sweepMap.get(id)).filter(Boolean);
const poolRecords=()=>state.pool.map(id=>sweepMap.get(id)).filter(Boolean);
const short=s=>`S${String(seriesMap.get(s.series_id).series_index).padStart(2,'0')}W${s.sweep_index}T${channelMap.get(s.trace_id).trace_index}`;
const name=s=>`${short(s)} · ${s.trace_label}${s.sweep_label?' · '+s.sweep_label:''}`;
const chronological=(a,b)=>seriesMap.get(a.series_id).series_index-seriesMap.get(b.series_id).series_index||a.sweep_index-b.sweep_index||channelMap.get(a.trace_id).trace_index-channelMap.get(b.trace_id).trace_index;
const groupSweeps=id=>DATA.sweeps.filter(s=>s.group_id===id).sort(chronological);
const sweepColors=new Map();
for(const g of DATA.groups){const rows=groupSweeps(g.group_id),order=new Map();rows.forEach((s,i)=>{const key=`${s.series_id}/${s.sweep_index}`;if(!order.has(key))order.set(key,order.size+1);s.group_sweep_index=order.get(key);const t=rows.length>1?i/(rows.length-1):1;sweepColors.set(s.sweep_id,'#'+[175,200,220].map((v,k)=>Math.round(v+([18,63,104][k]-v)*t).toString(16).padStart(2,'0')).join(''));});}
const color=s=>sweepColors.get(s.sweep_id)||palette[0];
const units=()=>state.mode==='normalized'?'normalized':'pA';
const events=sid=>(DATA.events||[]).filter(e=>e.series_id===sid);
const eventText=sid=>events(sid).map(e=>`W${e.sweep}: ${e.label}`).join(' · ');
function options(id,items,value){const select=$(id);select.innerHTML='';for(const [v,text] of items){const o=document.createElement('option');o.value=v;o.textContent=text;select.append(o);}if(items.some(i=>i[0]===value))select.value=value;return select.value;}
function status(id,text,error=false){$(id).textContent=text;$(id).classList.toggle('error',error);}
function download(name,parts,type){const blob=new Blob(Array.isArray(parts)?parts:[parts],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
function busy(button,task){button.disabled=true;Promise.resolve().then(task).catch(e=>status('exportStatus',e.message,true)).finally(()=>button.disabled=false);}

function populateFiles(){state.fileId=options('fileSelect',DATA.files.map(f=>[f.file_id,`${f.file_name} · ${f.n_groups} groups / ${f.n_series} series`]),state.fileId);populateGroups();}
function populateGroups(){if(!state.groupId)state.groupId=DATA.groups.find(g=>g.file_id===state.fileId&&groupKey(g.group_id)===workspace.lastGroup(fileKey(state.fileId)))?.group_id;state.groupId=options('groupSelect',DATA.groups.filter(g=>g.file_id===state.fileId).map(g=>[g.group_id,`${g.group_id} · ${g.group_label}`]),state.groupId);populateSeries();}
function populateSeries(){loadGroupWorkspace();state.seriesId=options('seriesSelect',forGroup(state.groupId).map(s=>[s.series_id,`S${String(s.series_index).padStart(2,'0')} · ${s.protocol_name} · ${s.series_label}`]),state.seriesId);populateTraces();}
function populateTraces(){
  state.traceId=options('traceSelect',channels(state.seriesId).map(t=>[t.trace_id,`${t.trace_label} · ${t.recording_mode}`]),state.traceId);
  if(!state.pool.length||sweepMap.get(state.pool[0])?.group_id!==state.groupId){state.pool=groupSweeps(state.groupId).map(s=>s.sweep_id);state.selected=new Set(state.pool);}
  const count=sweeps(state.traceId).length;
  $('sweepStart').value=1;$('sweepEnd').value=count;$('sweepStart').max=count;$('sweepEnd').max=count;
  const choices=forGroup(state.groupId).flatMap(s=>channels(s.series_id).map(t=>[t.trace_id,`S${String(s.series_index).padStart(2,'0')} · ${t.trace_label} · ${s.protocol_name}`]));
  options('analysisTraceSelect',choices,state.traceId);populateSourceSweeps();
  if(!cursorInitialized){const s=visible()[0],segs=s?.segments.filter(x=>x.stored)||[],seg=segs.find(x=>x.increment_mV)||segs[1]||segs[0];if(seg)addCursor(seg.start_s+seg.duration_s*.85,seg.start_s+seg.duration_s*.95);cursorInitialized=true;}
  applyWorkspaceView();
}
function navigateSeries(sid){if($('trendFocus').value){$('trendFocus').value=sid;trendRevision++;}state.seriesId=sid;$('seriesSelect').value=sid;state.traceId=null;populateTraces();renderAll();}
function populateSourceSweeps(){options('analysisSweepSelect',sweeps($('analysisTraceSelect').value).map(s=>[s.sweep_id,`W${s.sweep_index}${s.sweep_label?' · '+s.sweep_label:''}`]));}
function selectAll(flag){state.selected=new Set(flag?state.pool:[]);renderSelection();}
function addSources(ids){for(const id of ids){if(state.pool.includes(id))state.selected.add(id);}renderSelection();}
function applyQuick(){
  const result=M.parseQuick($('quickSweepInput').value,forGroup(state.groupId),channels,channelMap.get(state.traceId)?.trace_label,sweeps);
  if(result.errors.length){status('sweepSelectionStatus',result.errors.join('；')+'。原选择保留。',true);return;}
  state.selected=new Set(result.ids);renderSelection();
}
function renderChips(){
  const box=$('sweepSelection');box.innerHTML='';
  for(const s of poolRecords()){
    const label=document.createElement('label');label.className='sweep-chip';label.title=s.sweep_id;
    const cb=document.createElement('input');cb.type='checkbox';cb.checked=state.selected.has(s.sweep_id);cb.setAttribute('aria-label',`显示 ${short(s)} ${s.trace_label}`);
    cb.onchange=()=>{if(cb.checked)state.selected.add(s.sweep_id);else state.selected.delete(s.sweep_id);renderSelection();};
    const swatch=document.createElement('span');swatch.className='chip-swatch';swatch.style.background=color(s);
    label.append(cb,swatch,document.createTextNode(name(s)));box.append(label);
  }
  status('sweepSelectionStatus',`已显示 ${visible().length} / ${state.pool.length} 条 trace · 当前 Group ${forGroup(state.groupId).length} 个 Series · ${state.mode}`);
  const old=$('exportTarget').value;
  options('exportTarget',[['all','全部选中显示的 trace'],...visible().map(s=>[s.sweep_id,name(s)])],old);
}
function plot(id,data,layout={},extra={}){
  const {title,xaxis={},yaxis={},...rest}=layout;
  $(id).style.height=(layout.height||360)+'px';
  if(title){let caption=$(id+'Caption');if(!caption){caption=document.createElement('div');caption.id=id+'Caption';caption.className='figure-caption';$(id).before(caption);}caption.textContent=title.text||title;}
  const axis={showline:true,linecolor:'#767676',linewidth:1,ticks:'outside',ticklen:4,showgrid:false,automargin:true,zeroline:false};
  return Plotly.react(id,data,{margin:{l:70,r:20,t:24,b:95},font:{family:'Arial, Helvetica, sans-serif',size:12,color:'#272727'},colorway:palette,paper_bgcolor:'#fff',plot_bgcolor:'#fff',height:360,legend:{orientation:'h',y:-.24,x:0,yanchor:'top',font:{size:11}},uirevision:state.groupId,...rest,xaxis:{...axis,...xaxis},yaxis:{...axis,...yaxis}},{responsive:true,displaylogo:false,toImageButtonOptions:{format:'svg'},...extra});
}
const legendTimers=new Map();
function renderSweepLegend(id,records){
  const box=$(id),scrollTop=box.scrollTop;box.replaceChildren();
  for(const s of records){const button=document.createElement('button');button.type='button';button.dataset.sweepId=s.sweep_id;button.setAttribute('aria-pressed',String(state.selected.has(s.sweep_id)));button.setAttribute('aria-label',`图例 ${name(s)}`);button.title=`${name(s)} · 单击隐藏/显示，双击独显/恢复全部`;
    const swatch=document.createElement('span');swatch.className='chip-swatch';swatch.style.background=color(s);const text=document.createElement('span');text.className='legend-label';text.textContent=name(s);button.append(swatch,text);
    button.onclick=()=>{clearTimeout(legendTimers.get(id));legendTimers.set(id,setTimeout(()=>{state.selected.has(s.sweep_id)?state.selected.delete(s.sweep_id):state.selected.add(s.sweep_id);renderSelection();},300));};
    button.ondblclick=()=>{clearTimeout(legendTimers.get(id));state.selected=state.selected.size===1&&state.selected.has(s.sweep_id)?new Set(state.pool):new Set([s.sweep_id]);renderSelection();};box.append(button);
  }
  box.scrollTop=scrollTop;
}
function displayCurve(s){
  const x=[],y=[];let prevSeg=null;
  for(let i=0;i<s.time_s.length;i++){
    const t=s.time_s[i],seg=s.segments.find(z=>z.stored&&t>=z.start_s-1e-9&&t<z.end_s-1e-9);
    if(prevSeg&&seg&&seg.index!==prevSeg.index&&seg.start_s>prevSeg.end_s+1e-8){x.push(null);y.push(null);}
    x.push(t);y.push(M.valueTransform(s.value_pA[i],state.mode,s.metrics));prevSeg=seg;
  }return {x,y};
}
function cursorShapes(){return state.cursors.flatMap((c,i)=>[c.start,...(c.type==='window'?[c.end]:[])].map(x=>({type:'line',x0:x,x1:x,y0:0,y1:1,yref:'paper',editable:true,line:{color:palette[i%palette.length],width:2,dash:'dot'}})));}
let legendTimer;
function bindPlotEvents(){
  const p=$('tracePlot');if(p.__ephysBound)return;p.__ephysBound=true;
  p.on('plotly_legendclick',e=>{
    clearTimeout(legendTimer);const id=e.data[e.curveNumber]?.meta?.sweep_id;if(!id)return false;
    legendTimer=setTimeout(()=>{if(state.selected.has(id))state.selected.delete(id);else state.selected.add(id);renderSelection();},350);return false;
  });
  p.on('plotly_legenddoubleclick',e=>{
    clearTimeout(legendTimer);const id=e.data[e.curveNumber]?.meta?.sweep_id;if(!id)return false;
    state.selected=state.selected.size===1&&state.selected.has(id)?new Set(state.pool):new Set([id]);renderSelection();return false;
  });
  p.on('plotly_relayout',change=>{
    let changed=false,index=0;
    for(const c of state.cursors){for(const side of c.type==='point'?['start']:['start','end']){
      const x=change[`shapes[${index}].x0`]??change[`shapes[${index}].x1`];index++;
      if(x!==undefined&&Number.isFinite(Number(x))){c[side]=Number(x);if(c.type==='point')c.end=c.start;changed=true;}
    }}
    if(changed){for(const c of state.cursors)if(c.start>c.end)[c.start,c.end]=[c.end,c.start];renderCursorControls();renderTrace();scheduleStats();}
  });
}
function renderTrace(){
  renderSweepLegend('traceLegend',poolRecords());
  const data=visible().map(s=>({...displayCurve(s),type:'scatter',mode:'lines',name:name(s),meta:{sweep_id:s.sweep_id},line:{color:color(s),width:1.15},hovertemplate:`${esc(name(s))}<br>%{x:.6f} s<br>%{y:.5g} ${units()}<extra></extra>`}));
  const layout={showlegend:false,margin:{l:72,r:22,t:25,b:60},height:510,xaxis:{title:{text:'Protocol time (s)'}},yaxis:{title:{text:units()},zeroline:true,zerolinecolor:'#dce1e5'},shapes:cursorShapes(),annotations:[]};
  if(!visible().length)layout.annotations=[{text:'未选中 sweep · 使用全选或勾选显示',xref:'paper',yref:'paper',x:.5,y:.5,showarrow:false}];
  plot('tracePlot',data,layout,{edits:{shapePosition:true},doubleClick:'reset',doubleClickDelay:300}).then(bindPlotEvents);
}
function renderSummary(){
  const f=fileMap.get(state.fileId),g=groupMap.get(state.groupId),s=seriesMap.get(state.seriesId),t=channelMap.get(state.traceId),v=visible();
  $('statFile').textContent=f?.file_name||'—';$('statPath').textContent=f?.relative_path||'';$('statGroup').textContent=`G${g?.group_index}`;$('statGroupLabel').textContent=g?.group_label||'';
  $('statStage').textContent=annotations[state.seriesId]?.stage||s?.stage_class||'';$('statProtocol').textContent=s?.protocol_name||'';$('statCount').textContent=`${v.length} / ${state.pool.length}`;$('statTrace').textContent=[...new Set(v.map(s=>s.trace_label))].join(', ');
  const vals=v.map(s=>s.metrics.pulse_steady_current_pA).filter(x=>x!=null&&Number.isFinite(x)).sort((a,b)=>a-b);
  $('statSteady').textContent=vals.length?fmt((vals[Math.floor((vals.length-1)/2)]+vals[Math.floor(vals.length/2)])/2,1):'—';$('statClip').textContent=`${v.filter(s=>s.metrics.clip_metadata).length}/${v.length}`;
  $('recordInfo').innerHTML=`<p>${esc(f?.file_name)}</p><p>${esc(g?.group_id)} · ${esc(g?.group_label)}</p><p>${esc(s?.series_id)} · ${esc(s?.series_label)}</p><p>${esc(s?.series_time)} · ${fmt(s?.group_time_min,2)} min</p><p>${esc(t?.trace_label)} · ${esc(t?.recording_mode)}</p><p>原始标记 ${esc(eventText(s?.series_id)||'无')}</p>`;
}
function renderTable(){
  const body=$('seriesTable').querySelector('tbody');body.innerHTML='';
  for(const s of forGroup(state.groupId)){
    const tr=document.createElement('tr');tr.className='selectable'+(s.series_id===state.seriesId?' selected':'');const note=annotations[s.series_id]||{};
    tr.innerHTML=[s.series_id,note.stage||s.stage_class,s.protocol_name,s.series_label,fmt(s.group_time_min,2),s.n_sweeps,s.trace_labels,s.clip_sweeps_by_trace.reduce((a,b)=>a+b,0),s.median_steady_by_trace_pA.map(x=>fmt(x,1)).join(' / '),eventText(s.series_id),[note.dose,note.comment].filter(Boolean).join(' · ')].map(x=>`<td>${esc(x)}</td>`).join('');
    tr.onclick=()=>navigateSeries(s.series_id);body.append(tr);
  }
}
function renderAnnotation(){const n=annotations[state.seriesId]||{};$('stageNote').value=n.stage||'';$('doseNote').value=n.dose||'';$('commentNote').value=n.comment||'';status('annotationStatus',n.saved_at?'已保存 '+n.saved_at:'当前 Series 尚无人工注释');}
function saveAnnotation(){
  const note={stage:$('stageNote').value.trim(),dose:$('doseNote').value.trim(),comment:$('commentNote').value.trim(),saved_at:new Date().toLocaleString()};
  try{localStorage.setItem(annotationKey,JSON.stringify({...annotations,[state.seriesId]:note}));annotations[state.seriesId]=note;renderAnnotation();renderSummary();renderTable();}catch(e){status('annotationStatus','保存失败，请导出注释备份。'+e.message,true);}
}

const rawCache=new Map(),pendingRaw=new Map();
async function raw(s){
  if(rawCache.has(s.sweep_id)){const y=rawCache.get(s.sweep_id);rawCache.delete(s.sweep_id);rawCache.set(s.sweep_id,y);return y;}
  if(pendingRaw.has(s.sweep_id))return pendingRaw.get(s.sweep_id);
  const p=(async()=>{const response=await fetch(s.raw_url);if(!response.ok)throw Error(`读取失败 ${short(s)} (HTTP ${response.status})`);const y=M.parseNpy(await response.arrayBuffer(),s.n_samples);rawCache.set(s.sweep_id,y);while(rawCache.size>Math.max(128,state.pool.length))rawCache.delete(rawCache.keys().next().value);return y;})();
  pendingRaw.set(s.sweep_id,p);try{return await p;}finally{pendingRaw.delete(s.sweep_id);}
}
function addCursor(start,end){const id='C'+(++state.cursorNumber);state.cursors.push({id,name:id==='C1'?'Steady_mean':id,type:'window',start:start??.1,end:end??.2,statistic:'mean'});}
function renderCursorControls(){
  const box=$('cursorList');box.innerHTML='';
  for(const c of state.cursors){
    const row=document.createElement('div');row.className='cursor-row';row.style.setProperty('--cursor-color',palette[state.cursors.indexOf(c)%palette.length]);
    row.innerHTML=`<b>${c.id}</b><select aria-label="${c.id} 类型"><option value="window">时间窗</option><option value="point">单点</option><option value="recovery">负峰恢复时间</option></select><label>起点 (s) <input type="number" step="any" value="${Number(c.start.toPrecision(12))}" aria-label="${c.id} 起点"></label><label>终点 (s) <input type="number" step="any" value="${Number(c.end.toPrecision(12))}" aria-label="${c.id} 终点"></label><button aria-label="移除 ${c.id}">移除</button>`;
    const inputs=row.querySelectorAll('input'),type=row.querySelector('select');type.value=c.type;inputs[1].disabled=c.type==='point';
    const nameLabel=document.createElement('label');nameLabel.textContent='名称 ';const nameInput=document.createElement('input');nameInput.type='text';nameInput.className='cursor-name';nameInput.maxLength=80;nameInput.value=c.name||c.id;nameInput.setAttribute('aria-label',`${c.id} 名称`);nameInput.oninput=()=>{c.name=nameInput.value.trim()||c.id;scheduleStats();};nameInput.onchange=()=>{nameInput.value=c.name;};nameLabel.append(nameInput);row.insertBefore(nameLabel,type);
    const statLabel=document.createElement('label');statLabel.textContent='统计量 ';
    const statSelect=document.createElement('select');statSelect.setAttribute('aria-label',`${c.id} 统计量`);
    for(const key of ['mean','min','max']){const o=document.createElement('option');o.value=key;o.textContent=key;statSelect.append(o);}
    statSelect.value=c.statistic||'mean';statSelect.onchange=()=>{c.statistic=statSelect.value;scheduleStats();};statLabel.append(statSelect);statLabel.hidden=c.type==='recovery';row.insertBefore(statLabel,row.querySelector('button'));
    const change=()=>{const a=Number(inputs[0].value),b=type.value==='point'?a:Number(inputs[1].value);if(inputs[0].value===''||(type.value!=='point'&&inputs[1].value==='')||!Number.isFinite(a)||!Number.isFinite(b)||b<a||(type.value==='recovery'&&b===a)){c.invalid=true;scheduleStats();return false;}c.invalid=false;c.type=type.value;c.start=a;c.end=b;inputs[1].disabled=c.type==='point';if(c.type==='point')inputs[1].value=c.start;renderTrace();scheduleStats();return true;};
    inputs.forEach(input=>{input.oninput=change;input.onchange=change;});type.onchange=()=>{if(change())renderCursorControls();};row.querySelector('button').onclick=()=>{state.cursors=state.cursors.filter(x=>x!==c);renderCursorControls();renderTrace();scheduleStats();};
    if(c.type==='recovery'){
      const settings=document.createElement('div');settings.className='recovery-settings';
      const defaults={baseline_mode:'auto',baseline_pA:0,baseline_start:0,baseline_end:.1,recovery_rule:'band',tolerance_pct:5,hold_ms:1};for(const [key,value] of Object.entries(defaults))if(c[key]===undefined)c[key]=value;
      const fields=[];
      const select=(label,key,choices)=>{const wrap=document.createElement('label');wrap.textContent=label+' ';const el=document.createElement('select');el.setAttribute('aria-label',`${c.id} ${label}`);for(const [value,text] of choices){const o=document.createElement('option');o.value=value;o.textContent=text;el.append(o);}el.value=c[key];el.onchange=()=>{c[key]=el.value;c.invalid=false;renderCursorControls();scheduleStats();};wrap.append(el);settings.append(wrap);};
      const number=(label,key)=>{const wrap=document.createElement('label');wrap.textContent=label+' ';const el=document.createElement('input');el.type='number';el.step='any';el.value=c[key];el.setAttribute('aria-label',`${c.id} ${label}`);fields.push({el,key});wrap.append(el);settings.append(wrap);};
      select('Baseline','baseline_mode',[['auto','当前 sweep 平台基线'],['window','指定时间窗均值'],['manual','手动原始电流 (pA)']]);
      if(c.baseline_mode==='window'){number('基线起点 (s)','baseline_start');number('基线终点 (s)','baseline_end');}
      if(c.baseline_mode==='manual')number('基线电流 (pA)','baseline_pA');
      select('恢复判定','recovery_rule',[['band','进入 baseline 容差带'],['cross','首次达到 / 越过 baseline']]);
      if(c.recovery_rule==='band'){number('容差 (%)','tolerance_pct');number('持续 (ms)','hold_ms');}
      for(const {el} of fields)el.oninput=el.onchange=()=>{const next={...c};for(const {el,key} of fields)next[key]=el.value===''?NaN:Number(el.value);const valid=fields.every(({key})=>Number.isFinite(next[key]))&&next.baseline_end>next.baseline_start&&next.tolerance_pct>=0&&next.tolerance_pct<100&&next.hold_ms>=0;c.invalid=!valid;if(valid)Object.assign(c,next,{invalid:false});scheduleStats();};
      const info=document.createElement('span');info.className='recovery-note';info.textContent='窗口内负峰 → 恢复时间（ms）；始终用原始 pA 判定。未恢复或数据间断时留空。';settings.append(info);row.append(settings);
    }
    box.append(row);
  }
}
let statsTimer;
function scheduleStats(){saveWorkspace();clearTimeout(statsTimer);const gen=++state.generation;state.readyGeneration=-1;state.rows=[];renderStatsRows();$('exportCursorCsv').disabled=true;
  state.trendRows=[];renderTrend('读取完整采样点…');
  status('analysisStatus','读取完整采样点…');statsTimer=setTimeout(()=>calculateStats(gen),80);
}
async function calculateStats(gen){
  const selected=visible(),records=$('trendScope').value==='group'?poolRecords():selected,cursors=state.cursors.map(c=>({...c})),mode=state.basis==='display'?state.mode:'raw',trendMode=$('trendY').value==='display'?state.mode:$('trendY').value==='baseline'?'baseline':'raw',unit=mode==='normalized'?'normalized':'pA',rows=[],trendRows=[];
  if(cursors.some(c=>c.invalid)){renderTrend('Cursor 范围无效；请修正下方输入。');status('analysisStatus','Cursor 范围无效；请修正输入。',true);return;}
  if(!records.length||!cursors.length){if(gen===state.generation){status('analysisStatus',!selected.length?'未选中 sweep':'没有 cursor；点击“增加 cursor”。');state.readyGeneration=gen;renderTrend(!cursors.length?'没有 cursor；请在下方增加 cursor。':'当前范围没有 sweep。');}return;}
  try{
    for(const s of records){if(gen!==state.generation)return;const y=await raw(s);for(const c of cursors){
      const base={record_id:s.sweep_id,file_id:s.file_id,group_id:s.group_id,series_id:s.series_id,trace_id:s.trace_id,trace_label:s.trace_label,trace_index:channelMap.get(s.trace_id).trace_index,protocol_name:seriesMap.get(s.series_id).protocol_name,sweep_index:s.sweep_index,sweep_label:s.sweep_label,sweep_recorded_at:s.sweep_recorded_at||'',group_elapsed_s:s.group_elapsed_s??null,group_sweep_index:s.group_sweep_index,time_source:s.time_source||'unavailable',cursor_id:c.id,cursor_name:c.name||c.id,cursor_type:c.type,start_s:c.start,end_s:c.end,window_convention:c.type==='point'?'nearest_stored_sample':'[start,end)',clip_metadata:s.metrics.clip_metadata};
      const tr={...base,basis:trendMode,unit:trendMode==='normalized'?'normalized':'pA',...M.measure(y,s,c,trendMode)};trendRows.push(tr);
      if(state.selected.has(s.sweep_id))rows.push(mode===trendMode?tr:{...base,basis:mode,unit,...M.measure(y,s,c,mode)});
    }}
    if(gen!==state.generation)return;state.rows=rows;state.trendRows=trendRows;state.readyGeneration=gen;renderStatsRows();renderTrend();$('exportCursorCsv').disabled=!rows.length;status('analysisStatus',selected.length?`${selected.length} 条显示 sweep × ${cursors.length} 个 cursor · 完整采样计算 · ${[...new Set(rows.map(r=>r.unit))].join(' / ')}`:'未选中 sweep；上方趋势图可独立显示当前 Group。');
  }catch(e){if(gen!==state.generation)return;const message=`${e.message}。请通过本地启动器打开平台；不会用降采样数据替代统计。`;status('analysisStatus',message,true);renderTrend(message);}
}
function recoveryDetails(r){return r.cursor_type==='recovery'?`baseline ${fmt(r.baseline_pA,3)} pA · 负峰 ${fmt(r.peak_current_pA,3)} pA @ ${fmt(r.peak_time_s,6)} s · 恢复 @ ${fmt(r.recovery_at_s,6)} s · 容差 ±${fmt(r.tolerance_pA,3)} pA · 持续 ${fmt(r.hold_ms,3)} ms`:'—';}
let statsRange=null,statsGrid=[];
function groupNameCell(tr,text){
  const cell=tr.insertCell();
  cell.className='group-name';
  cell.textContent=text;
  return cell;
}
function renderStatsRows(){
  const body=$('cursorTable').tBodies[0];
  body.replaceChildren();statsRange=null;statsGrid=[];
  $('copyStats').disabled=!state.rows.length;
  $('copyStats').textContent='复制所选列';
  status('copyStatsStatus','');
  let previousRecord=null,labelCell;
  for(const r of state.rows){
    const tr=body.insertRow(),s=sweepMap.get(r.record_id);
    if(r.record_id!==previousRecord){
      labelCell=groupNameCell(tr,name(s));
      labelCell.dataset.column=0;
      previousRecord=r.record_id;
    }else labelCell.rowSpan++;
    const gridRow=[labelCell];
    const cells=[`${r.cursor_name} (${r.cursor_id})`,r.cursor_type==='point'?fmt(r.start_s,6):`${fmt(r.start_s,6)}–${fmt(r.end_s,6)}`,r.n,r.statistic==='recovery_time'?'负峰恢复时间':r.statistic,fmt(r.value,6),`${r.unit} · ${r.status}${r.clip_metadata?' · CLIP':''}`,recoveryDetails(r)];
    for(const value of cells){
      const cell=tr.insertCell();
      cell.textContent=value;
      cell.dataset.column=gridRow.length;
      gridRow.push(cell);
    }
    statsGrid.push(gridRow);
  }
}
function bindStatsCopy(){
  const table=$('cursorTable'),body=table.tBodies[0],column=$('copyStatsColumn'),button=$('copyStats');
  for(const [i,cell] of Array.from(table.tHead.rows[0].cells).entries())column.add(new Option(cell.textContent,i));
  column.value='5';
  function selectRange(range){
    statsRange=range;
    for(const cell of body.querySelectorAll('.copy-selected'))cell.classList.remove('copy-selected');
    if(range){
      for(let r=range.top;r<=range.bottom;r++)for(let c=range.left;c<=range.right;c++)statsGrid[r][c].classList.add('copy-selected');
    }
    button.textContent=range?'复制所选区域':'复制所选列';
    status('copyStatsStatus','');
  }
  let anchor=null;
  function extend(cell){
    const row=cell.parentElement.sectionRowIndex,col=Number(cell.dataset.column);
    selectRange({top:Math.min(anchor.row,row),bottom:Math.max(anchor.row,row),left:Math.min(anchor.col,col),right:Math.max(anchor.col,col)});
  }
  body.onpointerdown=e=>{
    const cell=e.target.closest('td');
    if(!cell||e.button!==0||e.pointerType==='touch')return;
    e.preventDefault();table.focus({preventScroll:true});
    anchor={row:cell.parentElement.sectionRowIndex,col:Number(cell.dataset.column)};extend(cell);
  };
  body.onpointerover=e=>{const cell=e.target.closest('td');if(anchor&&e.buttons===1&&cell)extend(cell);};
  addEventListener('pointerup',()=>{anchor=null;});
  addEventListener('pointercancel',()=>{anchor=null;});
  column.onchange=()=>selectRange(null);
  function copyData(){
    const col=Number(column.value);
    const {top,bottom,left,right}=statsRange??{top:0,bottom:body.rows.length-1,left:col,right:col};
    const lines=statsGrid.slice(top,bottom+1).map(row=>row.slice(left,right+1).map(cell=>{
      const value=cell.textContent;
      return value==='—'?'':value.replace(/[\t\r\n]/g,' ');
    }).join('\t'));
    return {text:lines.join('\r\n'),message:`已复制 ${lines.length} 行 × ${right-left+1} 列`};
  }
  button.onclick=async()=>{
    if(!body.rows.length)return;
    const {text,message}=copyData();
    try{
      let copied=false;
      const nativeCopy=e=>{
        if(!e.clipboardData)return;
        e.clipboardData.setData('text/plain',text);
        e.preventDefault();copied=true;
      };
      document.addEventListener('copy',nativeCopy,true);
      try{document.execCommand?.('copy');}finally{document.removeEventListener('copy',nativeCopy,true);}
      if(!copied)await navigator.clipboard.writeText(text);
      status('copyStatsStatus',message);
    }catch(e){status('copyStatsStatus','无法访问剪贴板，请使用统计 CSV。',true);}
  };
  table.oncopy=e=>{
    if(!body.rows.length||!e.clipboardData)return;
    const {text,message}=copyData();
    e.clipboardData.setData('text/plain',text);
    e.preventDefault();
    status('copyStatsStatus',message);
  };
  table.onkeydown=e=>{
    if(e.key==='Escape')selectRange(null);
  };
}

let trendRevision=0;
const trendXLabels={elapsed_min:'记录经过时间 (min)',elapsed_s:'记录经过时间 (s)',recorded:'记录钟表时间（DAT）',order:'Group sweep 顺序'};
function trendUnit(){return $('trendY').value==='nA'?'nA':$('trendY').value==='display'&&state.mode==='normalized'?'normalized':'pA';}
function seriesCode(s){return 'S'+String(s.series_index).padStart(2,'0');}
function seriesBands(records,key){
  const date=key==='recorded',groups=new Map();
  const axisValue=n=>date?new Date(n).toISOString().slice(0,-1):n;
  for(const record of records){
    const x=M.trendX(record,key);
    if(x===null)continue;
    const n=date?Date.parse(x+'Z'):x;
    if(!Number.isFinite(n))continue;
    const span=groups.get(record.series_id)??{id:record.series_id,low:n,high:n};
    span.low=Math.min(span.low,n);span.high=Math.max(span.high,n);groups.set(span.id,span);
  }
  const spans=Array.from(groups.values()).sort((a,b)=>a.low-b.low);
  const minimumPad={order:.42,elapsed_min:1/60,elapsed_s:1,recorded:1000}[key];
  return spans.map((s,i)=>{
    const pad=Math.max(minimumPad,(s.high-s.low)*.035);
    const left=i?Math.min(pad,Math.max(0,(s.low-spans[i-1].high)/2)):pad;
    const right=i+1<spans.length?Math.min(pad,Math.max(0,(spans[i+1].low-s.high)/2)):pad;
    const series=seriesMap.get(s.id);
    return {id:s.id,label:seriesCode(series),color:['#e7eff8','#f7ede1','#e3f1ee','#f1eaf6'][(series.series_index-1)%4],
      x0:axisValue(s.low-left),x1:axisValue(s.high+right),center:axisValue((s.low+s.high)/2),
      range:[axisValue(s.low-pad),axisValue(s.high+pad)]};
  });
}
function trendCurveName(c){return `${c.cursor_name} (${c.cursor_id}, ${c.statistic==='recovery_time'?'恢复时间 ms':c.statistic}) · ${c.trace_label} T${c.trace_index} · ${c.protocol_name}`;}
function renderTrend(message=''){
  const xKey=$('trendX').value,unit=trendUnit(),curves=M.trendCurves(state.trendRows,xKey,$('trendY').value==='nA'?.001:1),shown=curves.filter(c=>!state.trendHidden.has(c.key));
  state.trendCurves=curves;
  const focus=$('trendFocus').value;
  const scopeRecords=$('trendScope').value==='group'?poolRecords():visible();
  const bands=seriesBands(scopeRecords,xKey).filter(b=>!focus||focus===b.id);
  const previewRows=focus?state.trendRows.filter(r=>r.series_id===focus):state.trendRows;
  const previewCurves=focus?M.trendCurves(previewRows,xKey,$('trendY').value==='nA'?.001:1):curves;
  const displayed=previewCurves.filter(c=>!state.trendHidden.has(c.key));
  const cids=state.cursors.map(c=>c.id),protocols=[...new Set(curves.map(c=>c.protocol_name))],channelIds=[...new Set(curves.map(c=>`${c.trace_label}/${c.trace_index}`))];
  const dashes=['solid','dash','dot','dashdot','longdash','longdashdot'],symbols=['circle','square','diamond','triangle-up','triangle-down','cross'];
  const style=c=>{const i=Math.max(0,cids.indexOf(c.cursor_id));return {color:palette[i%palette.length],dash:dashes[(protocols.indexOf(c.protocol_name)+Math.floor(i/palette.length))%dashes.length],symbol:symbols[channelIds.indexOf(`${c.trace_label}/${c.trace_index}`)%symbols.length]};};
  for(const c of curves)c.visual=style(c);
  const box=$('trendLegend');box.replaceChildren();
  for(const c of previewCurves){const button=document.createElement('button'),swatch=document.createElement('span'),text=document.createElement('span'),st=style(c);button.type='button';button.setAttribute('aria-pressed',String(!state.trendHidden.has(c.key)));button.setAttribute('aria-label',`趋势曲线 ${trendCurveName(c)}`);swatch.className='chip-swatch';swatch.style.borderTop=`2px ${st.dash==='solid'?'solid':st.dash==='dot'?'dotted':'dashed'} ${st.color}`;text.className='legend-label';text.textContent=trendCurveName(c);const marker=document.createElement('span');marker.textContent={circle:'●',square:'■',diamond:'◆','triangle-up':'▲','triangle-down':'▼',cross:'+'}[st.symbol];marker.style.color=st.color;button.append(swatch,marker,text);button.onclick=()=>{state.trendHidden.has(c.key)?state.trendHidden.delete(c.key):state.trendHidden.add(c.key);renderTrend();};box.append(button);}
  let xr,yr;
  try{if(state.trendRows.length){xr=focus&&bands.length?bands[0].range:M.trendRange($('trendXMin').value,$('trendXMax').value,shown.flatMap(c=>c.points.map(p=>p.x)),xKey==='recorded');yr=M.trendRange($('trendYMin').value,$('trendYMax').value,shown.flatMap(c=>c.points.map(p=>p.y)));}status('trendAxesStatus','');}
  catch(error){status('trendAxesStatus',error.message+'；请修改后应用坐标设置。',true);$('exportTrendCsv').disabled=true;$('exportTrendSvg').disabled=true;return;}
  const unitsPresent=new Set(curves.map(c=>c.unit==='ms'?'ms':unit)),mixed=unitsPresent.size>1,facets=$('trendLayout').value==='facets'||mixed,count=Math.max(1,cids.length),xt=$('trendXTitle').value.trim()||trendXLabels[xKey],yt=$('trendYTitle').value.trim()||(unitsPresent.has('ms')&&!mixed?'负峰恢复时间 (ms)':`Cursor 电流 (${unit})`);
  const axis={showline:true,linecolor:'#767676',ticks:'outside',showgrid:false,zeroline:false,automargin:true,nticks:5,title:{text:esc(yt)},range:yr,autorange:!yr};
  const layout={showlegend:false,height:facets?Math.max(420,count*220+70):430,margin:{l:85,r:25,t:40,b:65},uirevision:`${state.groupId}/${xKey}/${$('trendY').value}/${$('trendLayout').value}/${trendRevision}`,xaxis:{title:{text:esc(xt)},type:xKey==='recorded'?'date':'linear',range:xr,autorange:!xr,anchor:facets&&count>1?'y'+count:'y',nticks:8},yaxis:{...axis},annotations:[]};
  if(facets){for(let i=0;i<count;i++){const index=i+1,top=1-i/count,bottom=1-(i+1)/count+(i<count-1?.13/count:0),c=state.cursors[i],label=c?.type==='recovery'?'负峰恢复时间 (ms)':($('trendYTitle').value.trim()||`Cursor 电流 (${unit})`);layout['yaxis'+(index===1?'':index)]={...axis,title:{text:esc(label)},domain:[bottom,top],anchor:'x'};if(c)layout.annotations.push({xref:'paper',yref:'paper',x:0,y:top,xanchor:'left',yanchor:'bottom',yshift:5,text:esc(`${c.name||c.id} (${c.id}, ${c.type==='recovery'?'恢复时间':c.statistic})`),showarrow:false,font:{color:palette[i%palette.length],size:12}});}}
  layout.shapes=bands.map(b=>({type:'rect',xref:'x',yref:'paper',x0:b.x0,x1:b.x1,y0:0,y1:1,fillcolor:b.color,line:{width:0},layer:'below'}));
  if(bands.length){
    layout.margin.t=65;
    const coord=x=>xKey==='recorded'?Date.parse(String(x).replace(' ','T')+'Z'):Number(x);
    const low=xr?coord(xr[0]):Math.min(...bands.map(b=>coord(b.x0)));
    const high=xr?coord(xr[1]):Math.max(...bands.map(b=>coord(b.x1)));
    const width=Math.max(100,$('cursorTrendPlot').clientWidth-110);
    let previous=-Infinity;
    for(const band of bands){
      const x=coord(band.center),pixel=(x-low)*width/(high-low||1);
      if(x<low||x>high||pixel-previous<32)continue;
      layout.annotations.push({xref:'x',yref:'paper',x:band.center,y:1,yshift:30,text:band.label,showarrow:false,font:{size:10,color:'#425569'},bgcolor:band.color});
      previous=pixel;
    }
  }
  const data=displayed.map(c=>{const st=style(c),i=Math.max(0,cids.indexOf(c.cursor_id));return {type:'scatter',mode:'lines+markers',name:esc(trendCurveName(c)),x:c.x,y:c.y,yaxis:facets&&i>0?'y'+(i+1):'y',connectgaps:false,line:{color:st.color,dash:st.dash,width:1.5},marker:{color:st.color,symbol:st.symbol,size:6,line:{color:'#272727',width:c.hoverRows.map(r=>r&&state.selected.has(r.record_id)?1.5:0)}},text:c.hoverRows.map(r=>r?`${esc(name(sweepMap.get(r.record_id)))}<br>${esc(r.cursor_name)} · ${r.statistic}<br>${esc(r.sweep_recorded_at.replace('T',' '))}<br>Group +${fmt(r.group_elapsed_s,6)} s · n=${r.n}${r.unit==='ms'?'<br>'+esc(recoveryDetails(r)):''}`:''),hovertemplate:`%{text}<br>%{y:.7g} ${c.unit==='ms'?'ms':unit}<extra></extra>`};});
  const valid=displayed.reduce((n,c)=>n+c.points.filter(p=>p.x!==null&&p.y!==null).length,0),missing=displayed.reduce((n,c)=>n+c.points.filter(p=>p.x===null||p.y===null).length,0);
  if(!valid)layout.annotations=[{xref:'paper',yref:'paper',x:.5,y:.5,text:esc(message||(focus&&!previewRows.length?'当前趋势范围内没有此 Series 的数据。':curves.length?'当前曲线没有可显示的有效值，或已全部隐藏。':'没有 cursor 统计结果。')),showarrow:false}];
  plot('cursorTrendPlot',data,layout);
  const records=new Set(previewRows.map(r=>r.record_id)).size;
  status('trendStatus',message||`${$('trendScope').value==='group'?'当前 Group 全部':'选中显示'}${focus?' · 预览 '+seriesCode(seriesMap.get(focus)):''}：${records} 条 trace × ${cids.length} 个 cursor · ${displayed.length} 条曲线 · ${valid} 个有效点${missing?' · '+missing+' 个点无有效样本或时间':''}${mixed?' · 电流与恢复时间自动分面（不同单位）':''}`);
  const ready=state.readyGeneration===state.generation&&valid>0;$('exportTrendCsv').disabled=!ready;$('exportTrendSvg').disabled=!ready;
}
function exportTrendCsv(){
  const rows=state.trendCurves.filter(c=>!state.trendHidden.has(c.key)).flatMap(c=>c.points.map(p=>({...p.row,plot_x_axis:$('trendX').value,plot_x:p.x,plot_y:p.y,plot_y_unit:c.unit==='ms'?'ms':trendUnit(),plot_scope:$('trendScope').value})));
  if(!rows.length)return;download('cursor_trend.csv','\uFEFF'+M.csv(rows,M.csvColumns(rows)),'text/csv;charset=utf-8');status('trendAxesStatus',`已导出 ${rows.length} 行趋势数据，保留原始记录时间、cursor 名称和统计量。`);
}
async function exportTrendSvg(){
  const graph=$('cursorTrendPlot'),width=Math.max(600,Math.round(graph.clientWidth)),height=parseInt(graph.style.height),uri=await Plotly.toImage(graph,{format:'svg',width,height});
  const source=uri.includes(';base64,')?atob(uri.split(',')[1]):decodeURIComponent(uri.slice(uri.indexOf(',')+1));
  const doc=new DOMParser().parseFromString(source,'image/svg+xml'),svg=doc.documentElement,ns='http://www.w3.org/2000/svg';
  const focus=$('trendFocus').value,curves=state.trendCurves.filter(c=>!state.trendHidden.has(c.key)&&(!focus||c.rows.some(r=>r.series_id===focus))),cols=width>=1000?3:width>=700?2:1,cell=(width-60)/cols;let y=height+22;
  for(let i=0;i<curves.length;i+=cols){let lines=1;for(let j=0;j<cols&&i+j<curves.length;j++){const c=curves[i+j],label=trendCurveName(c),limit=Math.max(20,Math.floor((cell-34)/6.5)),chunks=[];for(let k=0;k<label.length;k+=limit)chunks.push(label.slice(k,k+limit));lines=Math.max(lines,chunks.length);const x=30+j*cell,swatch=doc.createElementNS(ns,'line');swatch.setAttribute('x1',x);swatch.setAttribute('x2',x+20);swatch.setAttribute('y1',y-4);swatch.setAttribute('y2',y-4);swatch.setAttribute('stroke',palette[Math.max(0,state.cursors.findIndex(r=>r.id===c.cursor_id))%palette.length]);swatch.setAttribute('stroke-width','2');const dash={dash:'6,3',dot:'2,3',dashdot:'6,3,2,3',longdash:'10,3',longdashdot:'10,3,2,3'}[c.visual.dash];if(dash)swatch.setAttribute('stroke-dasharray',dash);svg.append(swatch);const mark=doc.createElementNS(ns,'text');mark.setAttribute('x',x+5);mark.setAttribute('y',y);mark.setAttribute('fill',c.visual.color);mark.setAttribute('font-size','10');mark.textContent={circle:'●',square:'■',diamond:'◆','triangle-up':'▲','triangle-down':'▼',cross:'+'}[c.visual.symbol];svg.append(mark);chunks.forEach((chunk,k)=>{const t=doc.createElementNS(ns,'text');t.setAttribute('x',x+28);t.setAttribute('y',y+k*15);t.setAttribute('font-family','Arial,sans-serif');t.setAttribute('font-size','11');t.textContent=chunk;svg.append(t);});}y+=lines*15+12;}
  svg.setAttribute('height',y+8);svg.setAttribute('viewBox',`0 0 ${width} ${y+8}`);const meta=doc.createElementNS(ns,'metadata');meta.textContent=JSON.stringify({scope:$('trendScope').value,x_axis:$('trendX').value,y_axis:$('trendY').value,time_anchor:'HEKA Sweep.Time',series_connections:false,preview_series:$('trendFocus').value||null,cursors:state.cursors,records:[...new Set(curves.flatMap(c=>c.rows.filter(r=>!focus||r.series_id===focus).map(r=>r.record_id)))]});svg.append(meta);
  download('cursor_trend.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml');status('trendAxesStatus','已导出趋势 SVG，包含坐标轴和完整曲线图例。');
}
function bindTrend(){
  $('trendFocus').onchange=()=>{trendRevision++;renderTrend();};
  for(const id of ['trendScope','trendY'])$(id).onchange=()=>{if(id==='trendY'){$('trendYMin').value='';$('trendYMax').value='';}scheduleStats();};
  $('trendX').onchange=()=>{$('trendXMin').value='';$('trendXMax').value='';const date=$('trendX').value==='recorded';for(const id of ['trendXMin','trendXMax'])$(id).placeholder=date?'YYYY-MM-DD HH:mm:ss':'自动';trendRevision++;renderTrend();};
  $('trendLayout').onchange=()=>renderTrend();$('applyTrendAxes').onclick=()=>{$('trendFocus').value='';trendRevision++;renderTrend();};
  $('resetTrendAxes').onclick=()=>{$('trendFocus').value='';for(const id of ['trendXTitle','trendXMin','trendXMax','trendYTitle','trendYMin','trendYMax'])$(id).value='';trendRevision++;renderTrend();};
  $('showTrendCurves').onclick=()=>{state.trendHidden.clear();renderTrend();};
  $('exportTrendCsv').onclick=exportTrendCsv;$('exportTrendSvg').onclick=()=>busy($('exportTrendSvg'),exportTrendSvg);
}

function pulseProtocols(records){
  const bySeries=new Map();
  for(const s of records){
    if(!s.segments.length)continue;
    if(!bySeries.has(s.series_id))bySeries.set(s.series_id,new Map());
    const variants=bySeries.get(s.series_id);
    const signature=JSON.stringify(s.segments.map(z=>[z.start_s,z.end_s,z.voltage_mV,z.stored,z.increment_mV]));
    if(!variants.has(signature))variants.set(signature,{s,sources:[]});
    variants.get(signature).sources.push(s);
  }
  const protocols=[];
  for(const [seriesId,variants] of bySeries){
    const series=seriesMap.get(seriesId),code='S'+String(series.series_index).padStart(2,'0');
    const base=`${series.protocol_name || 'Protocol'} (${code})`;
    for(const [i,variant] of Array.from(variants.values()).entries()){
      const label=variants.size===1?base:`${base} · 方案 ${i+1}`;
      protocols.push({...variant,label,color:palette[protocols.length%palette.length]});
    }
  }
  return protocols;
}
function pulseRows(protocols=pulseProtocols(visible())){
  return protocols.flatMap(({s,label,sources})=>s.segments.map(seg=>({
    protocol_label:label,protocol_name:seriesMap.get(s.series_id).protocol_name,
    series_id:s.series_id,file_id:s.file_id,group_id:s.group_id,
    record_id:s.sweep_id,trace_id:s.trace_id,sweep_index:s.sweep_index,trace_label:s.trace_label,
    selected_sweep_count:new Set(sources.map(source=>source.sweep_index)).size,
    source_records:sources.map(source=>source.sweep_id).join(';'),
    command_association:sources.every(source=>source.is_leak)?'linked_stimulus_not_leak_waveform':'stimulus',
    ...seg,sample_interval_s:s.dt_s,actual_sample_count:s.n_samples
  })));
}
function protocolCurve(s){const x=[],y=[];for(const seg of s.segments){x.push(seg.start_s,seg.end_s);y.push(seg.voltage_mV,seg.voltage_mV);}return {x,y};}
function renderPulse(){
  const protocols=pulseProtocols(visible()),rows=pulseRows(protocols),legend=$('pulseLegend');
  legend.hidden=!protocols.length;
  legend.innerHTML=protocols.map(p=>`<span class="protocol-key" title="${esc(p.sources.map(short).join(', '))}"><i style="background:${p.color}"></i><span class="legend-label">${esc(p.label)}</span></span>`).join('');
  plot('pulsePlot',protocols.map(p=>({...protocolCurve(p.s),mode:'lines',name:esc(p.label),line:{color:p.color,width:1.5},hovertemplate:'%{x:.6f} s<br>%{y:.3f} mV<extra>%{fullData.name}</extra>'})),{showlegend:false,margin:{l:72,r:22,t:25,b:60},xaxis:{title:{text:'Protocol time (s)'}},yaxis:{title:{text:'Command (mV)'}},height:300});
  const body=$('pulseTable').tBodies[0];body.replaceChildren();
  let previousProtocol=null,labelCell;
  for(const r of rows.slice(0,300)){
    const tr=body.insertRow();
    if(r.record_id!==previousProtocol){
      labelCell=groupNameCell(tr,r.protocol_label);
      previousProtocol=r.record_id;
    }else labelCell.rowSpan++;
    for(const value of [r.index,fmt(r.start_s,5),fmt(r.end_s,5),fmt(r.voltage_mV,3),r.stored?'Store':'NoStore',`${r.sample_start}–${r.sample_end}`,fmt(r.increment_mV,2)])tr.insertCell().textContent=value;
  }
  const count=new Set(protocols.map(p=>p.s.series_id)).size;
  status('pulseSummary',protocols.length?`${count} 个 Series · ${protocols.length} 个方案 · ${rows.length} 段${rows.length>300?' · 表格显示前 300 行，导出包含全部':''}`:'选中 sweep 后显示对应 Series 的刺激方案。');
  for(const id of ['exportPulseCsv','exportPulseJson','exportPulseSvg'])$(id).disabled=!rows.length;
}
function exportPulse(format){const rows=pulseRows();if(!rows.length){status('exportStatus','请先选中 sweep。',true);return;}if(format==='json')download('pulse_generator.json',JSON.stringify({source:'HEKA PGF reconstruction',native_heka_import:false,rows},null,2),'application/json');else download('pulse_generator.csv','\uFEFF'+M.csv(rows,Object.keys(rows[0])),'text/csv;charset=utf-8');status('exportStatus',`已导出 ${rows.length} 段 Pulse Generator 方案。`);}

function exportRecords(){const value=$('exportTarget').value;return value==='all'?visible():visible().filter(s=>s.sweep_id===value);}
async function exportCsv(records){
  if(!records.length)throw Error('没有选中显示的 sweep。');
  const mode=state.mode,unit=mode==='normalized'?'normalized':'pA';
  const keys=['record_id','file_id','group_id','series_id','trace_id','trace_label','sweep_index','sweep_label','sample_index','stored_time_s','protocol_time_s','command_voltage_mV','current_pA','display_value','display_unit','display_mode','clip_metadata'];
  const parts=['\uFEFF'+keys.join(',')+'\r\n'];
  for(let k=0;k<records.length;k++){
    const s=records[k],y=await raw(s),co=M.coordinates(s,y.length),fixed=[s.sweep_id,s.file_id,s.group_id,s.series_id,s.trace_id,s.trace_label,s.sweep_index,s.sweep_label].map(M.csvCell).join(',')+',';
    status('exportStatus',`正在导出完整 CSV · ${k+1}/${records.length} · ${name(s)}`);let lines=[];
    for(let i=0;i<y.length;i++){
      lines.push(fixed+[i,i*s.dt_s,co.times[i],co.volts[i],y[i],M.valueTransform(y[i],mode,s.metrics),unit,mode,s.metrics.clip_metadata].map(M.csvCell).join(','));
      if(lines.length===10000){parts.push(lines.join('\r\n')+'\r\n');lines=[];}
    }if(lines.length)parts.push(lines.join('\r\n')+'\r\n');
  }
  download(records.length===1?`${records[0].sweep_id}_full.csv`:'selected_traces_full.csv',parts,'text/csv;charset=utf-8');status('exportStatus',`已导出 ${records.length} 条完整 trace，共 ${records.reduce((a,s)=>a+s.n_samples,0).toLocaleString()} 个采样点。`);
}

function svgText(x,y,text,extra=''){return `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="13" ${extra}>${esc(text)}</text>`;}
function svgLabelLines(text,limit=112){const lines=[];let line='',size=0;for(const ch of String(text)){const step=ch.codePointAt(0)>255?2:1;if(size+step>limit){lines.push(line);line='';size=0;}line+=ch;size+=step;}if(line)lines.push(line);return lines;}
async function exportSvg(records,protocolOnly=false){
  if(!records.length)throw Error('没有选中显示的 sweep。');
  const protocols=pulseProtocols(records);
  if(protocolOnly&&!protocols.length)throw Error('选中 sweep 没有可用刺激方案。');
  const mode=state.mode,unit=mode==='normalized'?'normalized':'pA',loaded=[];let minY=Infinity,maxY=-Infinity,maxT=0,minV=Infinity,maxV=-Infinity;
  for(let i=0;i<records.length;i++){
    const s=records[i];maxT=Math.max(maxT,...s.segments.map(z=>z.end_s));for(const seg of s.segments){minV=Math.min(minV,seg.voltage_mV);maxV=Math.max(maxV,seg.voltage_mV);}
    if(!protocolOnly){const y=await raw(s);for(let j=0;j<y.length;j++){const v=M.valueTransform(y[j],mode,s.metrics);if(v!=null&&Number.isFinite(v)){minY=Math.min(minY,v);maxY=Math.max(maxY,v);}}loaded.push(y);}
    status('exportStatus',`准备 SVG · ${i+1}/${records.length}`);
  }
  if(!protocolOnly&&!Number.isFinite(minY))throw Error('当前显示变换没有有效数值，请切换原始电流。');
  const protocolPanels=protocols.map(p=>{
    const numbers=[...new Set(p.sources.map(source=>source.sweep_index))].sort((a,b)=>a-b);
    const ranges=[];
    for(let i=0;i<numbers.length;i++){
      const start=numbers[i];
      while(numbers[i+1]===numbers[i]+1)i++;
      ranges.push(start===numbers[i]?'W'+start:'W'+start+'–W'+numbers[i]);
    }
    return svgLabelLines(p.label+' · '+ranges.join(', '));
  });
  const protocolPageHeight=40+protocolPanels.reduce((h,lines)=>h+245+(lines.length-1)*17,0);
  const protocolLegendY=protocolOnly?255:630;
  const traceLegendY=protocolLegendY+Math.ceil(protocols.length/3)*22+22;
  const overviewHeight=(protocolOnly?traceLegendY:traceLegendY+Math.ceil(records.length/3)*22);
  const individualLabels=records.map(s=>svgLabelLines(`${name(s)} · Protocol: ${seriesMap.get(s.series_id).protocol_name}`)),individualHeights=individualLabels.map(lines=>440+Math.max(0,lines.length-1)*18);
  const height=protocolOnly?protocolPageHeight:overviewHeight+55+individualHeights.reduce((a,b)=>a+b,0), width=1000,x0=60,x1=790,top=65,bottom=protocolOnly?190:390,pTop=protocolOnly?65:470,pBottom=protocolOnly?190:580;
  const ySpan=protocolOnly?1:(maxY-minY||Math.max(Math.abs(minY)*.1,1)),vSpan=maxV-minV||20;
  const X=t=>x0+t/(maxT||1)*(x1-x0),Y=v=>bottom-15-(v-minY)/(ySpan)*(bottom-top-30),V=v=>pBottom-10-(v-minV)/vSpan*(pBottom-pTop-20);
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,`<title>Selected HEKA traces and protocol</title><desc>Full-resolution editable vector paths. No axes. Time, current and command scale bars. Mode ${esc(mode)}. ${protocolOnly?'Protocol only.':'Overlay, protocol, then each selected trace on a separate panel with shared scales.'}</desc><rect width="100%" height="100%" fill="white"/>`,svgText(60,25,`${fileMap.get(records[0].file_id).file_name} · ${groupMap.get(records[0].group_id).group_label}`)];
  const metadata={source_records:records.map(s=>s.sweep_id),display_mode:mode,full_resolution:true,axes:false,layout_sections:protocolOnly?['protocol']:['overlay','protocol','individual_traces'],individual_trace_order:protocolOnly?[]:records.map(s=>s.sweep_id),individual_shared_scales:!protocolOnly,protocols:protocols.map(p=>({label:p.label,series_id:p.s.series_id,record_id:p.s.sweep_id,source_records:p.sources.map(s=>s.sweep_id),segments:p.s.segments}))};parts.push(`<metadata>${esc(JSON.stringify(metadata))}</metadata>`);
  const individualPaths=[];
  if(!protocolOnly){
    for(let k=0;k<records.length;k++){
      const s=records[k],y=loaded[k],paths=[];
      for(const seg of s.segments){if(!seg.stored)continue;let path='',drawn=false;
        for(let i=seg.sample_start;i<Math.min(y.length,seg.sample_end);i++){const v=M.valueTransform(y[i],mode,s.metrics);if(v==null||!Number.isFinite(v)){drawn=false;continue;}const t=seg.start_s+(i-seg.sample_start)*s.dt_s;path+=(drawn?'L':'M')+X(t).toFixed(3)+','+Y(v).toFixed(3);drawn=true;}
        if(path)paths.push(`<path d="${path}" fill="none" stroke="${color(s)}" stroke-width="1"/>`);
      }individualPaths.push(paths.join(''));parts.push(`<g id="trace_${esc(s.sweep_id)}"><title>${esc(name(s))}</title>${paths.join('')}</g>`);
    }
    const sy=M.niceScale(ySpan),sx=M.niceScale(maxT);const yy=Y(minY),barX=845;
    parts.push(`<g id="current-scale"><path d="M${barX},${yy}v${-(Y(minY)-Y(minY+sy))} M${X(0)},${bottom+12}h${X(sx)-X(0)}" fill="none" stroke="#222" stroke-width="2"/>${svgText(barX+9,yy-10,`${sy.toPrecision(3)*1} ${unit}`)}${svgText(X(0),bottom+30,`${sx.toPrecision(3)*1} s`)}</g>`,svgText(60,445,'Protocol'));
  }
  function protocolScales(id){
    const sv=M.niceScale(vSpan),st=M.niceScale(maxT),pv=V(minV);
    parts.push(`<g id="${id}"><path d="M845,${pv}v${-(V(minV)-V(minV+sv))} M${X(0)},${pBottom+12}h${X(st)-X(0)}" stroke="#222" stroke-width="2" fill="none"/>${svgText(854,pv-10,`${sv.toPrecision(3)*1} mV`)}${svgText(X(0),pBottom+30,`${st.toPrecision(3)*1} s`)}</g>`);
  }
  let panelTop=40;
  for(const [index,{s,label,color:ink}] of protocols.entries()){
    const curve=protocolCurve(s),d=curve.x.map((x,i)=>(i?'L':'M')+X(x).toFixed(3)+','+V(curve.y[i]).toFixed(3)).join('');
    if(protocolOnly){
      const lines=protocolPanels[index],extra=(lines.length-1)*17;
      parts.push('<g data-series="'+esc(s.series_id)+'" transform="translate(0,'+panelTop+')">');
      lines.forEach((line,i)=>parts.push(svgText(60,20+i*17,line)));
      parts.push('<g transform="translate(0,'+extra+')">');
      panelTop+=245+extra;
    }
    parts.push(`<g id="protocol_${esc(s.sweep_id)}"><title>${esc(label)}</title><path d="${d}" fill="none" stroke="${ink}" stroke-width="1.3"/></g>`);
    if(protocolOnly||protocols.length===1){
      for(const z of s.segments)if(X(z.end_s)-X(z.start_s)>65)parts.push(svgText(X((z.start_s+z.end_s)/2),V(z.voltage_mV)-8,`${z.voltage_mV} mV`,'text-anchor="middle"'));
    }
    if(protocolOnly){protocolScales('protocol-scales-'+(index+1));parts.push('</g></g>');}
  }
  if(!protocolOnly)protocolScales('protocol-scales');
  function svgLegend(entries,startY){
    entries.forEach(({label,color:ink},i)=>{
      const x=60+(i%3)*310,y=startY+Math.floor(i/3)*22;
      const [line,...rest]=svgLabelLines(label,36);
      parts.push(`<path d="M${x},${y-4}h20" stroke="${ink}" stroke-width="2"/>`,svgText(x+28,y,rest.length?line+'…':line));
    });
  }
  if(!protocolOnly)svgLegend(protocols,protocolLegendY);
  if(!protocolOnly)svgLegend(records.map(s=>({label:name(s),color:color(s)})),traceLegendY);
  if(!protocolOnly){
    parts.push(`<g id="individual-traces">`,svgText(60,overviewHeight+25,'Individual selected traces · shared time and current scales'));
    let panelY=overviewHeight+45;const sy=M.niceScale(ySpan),sx=M.niceScale(maxT),yy=Y(minY);
    for(let i=0;i<records.length;i++){
      const s=records[i],labelExtra=Math.max(0,individualLabels[i].length-1)*18;
      parts.push(`<g id="individual_${esc(s.sweep_id)}" data-record-id="${esc(s.sweep_id)}" transform="translate(0,${panelY})"><title>${esc(s.sweep_id)} · ${esc(name(s))}</title>`);
      individualLabels[i].forEach((line,k)=>parts.push(svgText(60,25+k*18,line)));
      parts.push(`<g transform="translate(0,${labelExtra})"><g id="individual_trace_${esc(s.sweep_id)}">${individualPaths[i]}</g>`);
      parts.push(`<g id="individual_scales_${esc(s.sweep_id)}"><path d="M845,${yy}v${-(Y(minY)-Y(minY+sy))} M${X(0)},${bottom+12}h${X(sx)-X(0)}" fill="none" stroke="#222" stroke-width="2"/>${svgText(854,yy-10,`${sy.toPrecision(3)*1} ${unit}`)}${svgText(X(0),bottom+30,`${sx.toPrecision(3)*1} s`)}</g></g></g>`);
      panelY+=individualHeights[i];
    }
    parts.push('</g>');
  }
  parts.push('</svg>');download(protocolOnly?'selected_protocol.svg':records.length===1?`${records[0].sweep_id}.svg`:'selected_traces.svg',parts,'image/svg+xml');status('exportStatus',protocolOnly?`已导出 ${protocols.length} 个刺激方案的 SVG（含比例尺，无坐标轴）。`:`已导出 SVG：叠加 trace + Pulse Generator + ${records.length} 张逐条独立 trace，均为完整采样矢量、无坐标轴。`);
}

function renderSelection(){renderChips();renderSummary();renderTrace();renderPulse();scheduleStats();}
function renderAll(){renderChips();renderSummary();renderTrace();renderPulse();renderTable();renderAnnotation();renderCursorControls();scheduleStats();}
function bindSettingsFiles(){
  function bindImport(button,input,message,apply){
    $(button).onclick=()=>$(input).click();
    $(input).onchange=async()=>{
      try{
        const file=$(input).files[0];if(!file)return;
        status(message,apply(await file.text()));
      }catch(e){status(message,'导入失败：'+e.message,true);}
      finally{$(input).value='';}
    };
  }
  $('exportCursors').onclick=()=>{
    const settings={type:'heka-ephys-cursors',version:1,...cursorSettings()};
    download('ephys_cursors.json',JSON.stringify(settings,null,2),'application/json');
    status('cursorSettingsStatus',`已导出 ${settings.cursors.length} 个 cursor。`);
  };
  bindImport('importCursors','cursorFile','cursorSettingsStatus',text=>{
    const settings=EphysSession.parseCursorFile(text);
    workspace.save(fileKey(state.fileId),groupKey(state.groupId),{...workspaceSnapshot(),...settings},settings);
    Object.assign(state,settings);
    lastSavedCursors=JSON.stringify(settings);
    renderCursorControls();renderTrace();scheduleStats();
    return `已导入 ${settings.cursors.length} 个 cursor，适用于所有 DAT 和 Group。`;
  });
  $('exportWorkspace').onclick=()=>{
    saveWorkspace();
    const project={...JSON.parse(workspace.export()),cursorSettings:cursorSettings(),annotations};
    download('ephys_project.json',JSON.stringify(project,null,2),'application/json');
    status('projectStatus','已导出工程。');
  };
  bindImport('importWorkspace','workspaceFile','projectStatus',text=>{
    const project=JSON.parse(text);
    const notes=project?.annotations;
    if(notes!==undefined&&(!notes||typeof notes!=='object'||Array.isArray(notes)))throw Error('工程注释格式无效');
    const importedNotes=Object.fromEntries(Object.entries(notes??{}).map(([id,note])=>{
      if(!note||typeof note!=='object')throw Error('工程注释格式无效');
      return [id,Object.fromEntries(['stage','dose','comment','saved_at'].filter(key=>typeof note[key]==='string').map(key=>[key,note[key]]))];
    }));
    const missingFile=project?.lastFile&&!DATA.files.some(f=>fileKey(f.file_id)===project.lastFile);
    workspace.import(text);
    resumeWorkspace();
    if(notes){
      const merged={...annotations,...importedNotes};
      try{localStorage.setItem(annotationKey,JSON.stringify(merged));}
      catch(e){return '已恢复工程设置，浏览器未能保存导入的注释。';}
      annotations=merged;renderAnnotation();renderSummary();renderTable();
    }
    status('cursorSettingsStatus','Cursor 设置在所有 DAT 和 Group 中共用，并保存在当前浏览器。');
    return missingFile?'已导入工程设置。原 DAT 尚未载入，请在顶部更新文件列表。':'已导入工程并恢复记录与分析设置。';
  });
}
function bind(){
  $('fileSelect').onchange=e=>{if(e.target.value===state.fileId)return;saveWorkspace();state.fileId=e.target.value;state.groupId=state.seriesId=state.traceId=null;populateGroups();renderAll();};
  $('groupSelect').onchange=e=>{if(e.target.value===state.groupId)return;saveWorkspace();state.groupId=e.target.value;state.seriesId=state.traceId=null;populateSeries();renderAll();};
  $('seriesSelect').onchange=e=>navigateSeries(e.target.value);$('traceSelect').onchange=e=>{state.traceId=e.target.value;populateTraces();renderAll();};
  $('displayMode').onchange=e=>{state.mode=e.target.value;renderChips();renderTrace();scheduleStats();};
  for(const id of ['sweepStart','sweepEnd'])$(id).oninput=$(id).onchange=()=>{const a=Number($('sweepStart').value),b=Number($('sweepEnd').value);if(!Number.isInteger(a)||!Number.isInteger(b)||a<1||b<a||b>sweeps(state.traceId).length){status('sweepSelectionStatus','Sweep 范围无效。',true);return;}state.selected=new Set(sweeps(state.traceId).filter(s=>s.sweep_index>=a&&s.sweep_index<=b).map(s=>s.sweep_id));renderSelection();};
  $('selectAllSweeps').onclick=()=>selectAll(true);$('selectNoSweeps').onclick=()=>selectAll(false);$('selectionHeading').ondblclick=()=>selectAll(state.selected.size!==state.pool.length);
  $('applyQuickSweep').onclick=applyQuick;$('quickSweepInput').onkeydown=e=>{if(e.key==='Enter')applyQuick();};
  $('analysisTraceSelect').onchange=()=>{populateSourceSweeps();saveWorkspace();};$('analysisSweepSelect').onchange=saveWorkspace;$('addAnalysisSource').onclick=()=>addSources([$('analysisSweepSelect').value].filter(Boolean));$('addSelectedSources').onclick=()=>addSources(sweeps($('analysisTraceSelect').value).map(s=>s.sweep_id));
  $('addCursor').onclick=()=>{const s=visible()[0],end=s?.segments.at(-1)?.end_s||1;addCursor(end*.4,end*.5);renderCursorControls();renderTrace();scheduleStats();};
  $('clearCursors').onclick=()=>{state.cursors=[];renderCursorControls();renderTrace();scheduleStats();};$('analysisBasis').onchange=e=>{state.basis=e.target.value;scheduleStats();};
  $('exportCursorCsv').onclick=()=>{if(state.readyGeneration!==state.generation||!state.rows.length)return;download('cursor_statistics.csv','\uFEFF'+M.csv(state.rows,M.csvColumns(state.rows)),'text/csv;charset=utf-8');status('exportStatus',`已导出 ${state.rows.length} 行 cursor 数值。`);};
  $('exportSelection').onclick=()=>busy($('exportSelection'),()=>($('exportMode').value==='csv'?exportCsv(exportRecords()):exportSvg(exportRecords())));
  $('exportPulseCsv').onclick=()=>exportPulse('csv');$('exportPulseJson').onclick=()=>exportPulse('json');$('exportPulseSvg').onclick=()=>busy($('exportPulseSvg'),()=>exportSvg(visible(),true));
  $('saveAnnotation').onclick=saveAnnotation;$('downloadAnnotations').onclick=()=>download('ephys_annotations.json',JSON.stringify(annotations,null,2),'application/json');
  bindSettingsFiles();bindStatsCopy();
  const header=document.querySelector('header');
  new ResizeObserver(()=>{document.documentElement.style.scrollPaddingTop=(header.offsetHeight+8)+'px';}).observe(header);
  document.addEventListener('change',e=>{if(workspace.controls.includes(e.target.id))saveWorkspace();});
  addEventListener('pagehide',saveWorkspace);
}

function bindHelp(){
  const tip=$('moduleTooltip');let active=null;
  function hide(){tip.hidden=true;if(active)active.removeAttribute('aria-describedby');active=null;}
  for(const heading of document.querySelectorAll('[data-help]')){
    heading.classList.add('help-title');heading.tabIndex=0;
    const show=()=>{active=heading;tip.textContent=heading.dataset.help;tip.hidden=false;heading.setAttribute('aria-describedby','moduleTooltip');const r=heading.getBoundingClientRect();tip.style.left=Math.max(14,Math.min(r.left,innerWidth-tip.offsetWidth-14))+'px';tip.style.top=Math.max(10,Math.min(r.bottom+8,innerHeight-tip.offsetHeight-14))+'px';};
    heading.addEventListener('mouseenter',show);heading.addEventListener('focus',show);heading.addEventListener('mouseleave',hide);heading.addEventListener('blur',hide);
  }
  addEventListener('scroll',hide,true);addEventListener('keydown',e=>{if(e.key==='Escape')hide();});
}

if(typeof Plotly==='undefined')document.body.innerHTML='<main>缺少本地 plotly.min.js，请保留完整 outputs 文件夹。</main>';
else if(!DATA.files.length){
  document.querySelector('main').classList.add('empty-library');
  $('emptyLibrary').hidden=false;
  $('exportWorkspace').disabled=$('importWorkspace').disabled=true;
  bindHelp();
}else{bind();bindTrend();bindHelp();resumeWorkspace();}
