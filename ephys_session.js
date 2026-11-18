/* Local, versioned workspace preferences. Raw samples are never stored here. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.EphysSession=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const key='heka-ephys-workspace-v1';
  const controls=['displayMode','analysisBasis','sweepStart','sweepEnd','quickSweepInput','trendScope','trendFocus','trendX','trendY','trendLayout','trendXTitle','trendXMin','trendXMax','trendYTitle','trendYMin','trendYMax','exportMode'];
  function cleanCursors(snapshot){
    if(!Array.isArray(snapshot?.cursors))throw Error('设置文件缺少 cursor');
    const seen=new Set(),cursors=snapshot.cursors.map(c=>{
      if(!c||typeof c.id!=='string'||!/^C[1-9]\d*$/.test(c.id)||!Number.isSafeInteger(Number(c.id.slice(1)))||seen.has(c.id)||!['window','point','recovery'].includes(c.type)||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.end<c.start)throw Error('Cursor 设置无效或编号重复');seen.add(c.id);
      const result={id:c.id,name:String(c.name||c.id).slice(0,80),type:c.type,start:c.start,end:c.type==='point'?c.start:c.end,statistic:['mean','min','max'].includes(c.statistic)?c.statistic:'mean'};
      for(const [k,value] of Object.entries({baseline_mode:'auto',baseline_pA:0,baseline_start:0,baseline_end:.1,recovery_rule:'band',tolerance_pct:5,hold_ms:1}))result[k]=c[k]??value;
      if(!['auto','window','manual'].includes(result.baseline_mode)||!['band','cross'].includes(result.recovery_rule)||!['baseline_pA','baseline_start','baseline_end','tolerance_pct','hold_ms'].every(k=>Number.isFinite(result[k]))||result.baseline_end<=result.baseline_start||result.tolerance_pct<0||result.tolerance_pct>=100||result.hold_ms<0)throw Error('恢复时间参数无效');
      return result;
    });
    return {cursors,cursorNumber:Math.max(0,Number.isSafeInteger(snapshot.cursorNumber)?snapshot.cursorNumber:0,...cursors.map(c=>Number(c.id.slice(1))))};
  }
  function clean(snapshot){
    if(!Array.isArray(snapshot?.selected))throw Error('设置文件缺少 trace 选择');
    const view={};for(const id of controls)if(typeof snapshot.view?.[id]==='string')view[id]=snapshot.view[id].slice(0,500);
    const positive=v=>Number.isInteger(v)&&v>0?v:1;
    return {selected:[...new Set(snapshot.selected.filter(v=>typeof v==='string'&&/^\d+\/\d+\/\d+$/.test(v)))],...cleanCursors(snapshot),series:positive(snapshot.series),trace:positive(snapshot.trace),sourceSeries:positive(snapshot.sourceSeries),sourceTrace:positive(snapshot.sourceTrace),sourceSweep:positive(snapshot.sourceSweep),view};
  }
  function activeCursors(project){
    const entry=project.files[project.lastFile];
    const settings=project.cursorSettings??entry?.groups[entry.lastGroup];
    return settings?cleanCursors(settings):null;
  }
  function parseCursorFile(text){
    const parsed=JSON.parse(text);
    if(parsed?.files)throw Error('这是工程文件，请使用顶部的“导入工程”。');
    if(parsed?.type!=='heka-ephys-cursors'||parsed.version!==1)throw Error('请选择“导出 cursor”生成的 JSON。');
    return cleanCursors(parsed);
  }
  function create(storage){
    let data={version:1,lastFile:null,files:{}},blocked=false,error='';
    try{const raw=storage.getItem(key);if(raw){const parsed=JSON.parse(raw);if(parsed.version!==1||!parsed.files||typeof parsed.files!=='object')throw Error('缓存版本无效');for(const entry of Object.values(parsed.files))for(const value of Object.values(entry.groups))clean(value);activeCursors(parsed);data=parsed;}}
    catch(e){blocked=true;error='原缓存无法读取，已保留原内容；可导入有效设置恢复。';}
    const commit=next=>{storage.setItem(key,JSON.stringify(next));data=next;};
    function latest(){
      const raw=storage.getItem(key),current=raw?JSON.parse(raw):data;
      if(current.version!==1||!current.files)throw Error('缓存格式已改变，未覆盖原内容');
      return current;
    }
    return {key,controls,get error(){return error;},
      lastFile:()=>data.lastFile,
      lastGroup:f=>data.files[f]?.lastGroup,
      get:(f,g)=>{const item=data.files[f]?.groups?.[g];if(!item)return null;try{return clean(item);}catch(e){error='该 Group 的缓存无效，已保留原内容。';return null;}},
      cursorSettings:()=>activeCursors(data),
      save:(f,g,snapshot,cursorSettings)=>{
        if(blocked)throw Error(error);
        const current=latest(),entry=current.files[f]||{groups:{}};
        const next={...current,lastFile:f,files:{...current.files,[f]:{...entry,lastGroup:g,groups:{...entry.groups,[g]:clean(snapshot)}}}};
        if(cursorSettings)next.cursorSettings=cleanCursors(cursorSettings);
        commit(next);
      },
      export:()=>JSON.stringify(data,null,2),
      import:text=>{
        const parsed=JSON.parse(text);
        if(parsed?.type==='heka-ephys-cursors')throw Error('这是 cursor 文件，请使用 Cursor 编辑中的“导入 cursor”。');
        if(parsed?.version!==1||!parsed.files||typeof parsed.files!=='object'||Array.isArray(parsed.files))throw Error('请选择“导出工程”生成的 JSON');
        const incoming=Object.fromEntries(Object.entries(parsed.files).map(([f,entry])=>{
          if(!entry?.groups||typeof entry.groups!=='object'||Array.isArray(entry.groups))throw Error('文件设置结构无效');
          return [f,{lastGroup:entry.lastGroup,groups:Object.fromEntries(Object.entries(entry.groups).map(([g,snapshot])=>[g,clean(snapshot)]))}];
        }));
        const current=blocked?data:latest();
        const merged={...current.files,...Object.fromEntries(Object.entries(incoming).map(([f,entry])=>[
          f,{...entry,groups:{...current.files[f]?.groups,...entry.groups}}
        ]))};
        const cursorSettings=activeCursors({...parsed,files:incoming});
        commit({version:1,lastFile:typeof parsed.lastFile==='string'?parsed.lastFile:current.lastFile,files:merged,cursorSettings:cursorSettings??activeCursors(current)});
        blocked=false;error='';
      }
    };
  }
  return {key,controls,clean,cleanCursors,parseCursorFile,create};
});
