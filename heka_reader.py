"""Read supported HEKA voltage-clamp recordings into the local analysis library."""
import hashlib
import re
from pathlib import Path

import numpy as np
from pyheka import Bundle

from heka_core import clean, protocol_for, measurement, coordinates, display_indices

def stamp(value): return value.isoformat(timespec='milliseconds')

def stage_class(protocol, label):
    text = f'{protocol} {label}'.lower()
    if 'drug' in text: return 'drug / treatment'
    if 'slo' in text: return 'SLO assay'
    if 'xen' in text: return 'XEN condition'
    if 'kcnq' in text: return 'KCNQ assay'
    if 'iv' in text: return 'IV protocol'
    if re.search(r'(^|[^0-9])[+-]?\d+', text): return 'voltage monitor'
    return 'other protocol'

def legacy_payload(catalog):
    series = []
    traces = []
    sweeps = []
    groups = []
    file_payload=[]
    for f in catalog['files']:
        file_groups=[g for g in catalog['groups'] if g['file_id']==f['id']]
        file_series=[s for s in catalog['series'] if s['file_id']==f['id']]
        file_payload.append(dict(file_id=f['id'],file_name=f['name'],relative_path=f['path'],sha256=f['sha256'],version=f['version'],
                                 n_groups=len(file_groups),n_series=len(file_series)))
    for g in catalog['groups']:
        ss = [s for s in catalog['series'] if s['group_id']==g['id']]
        g['series_ids'] = [s['id'] for s in ss]
        groups.append(dict(group_id=g['id'],file_id=g['file_id'],group_index=g['index'],group_label=g['label'],
                           series_ids=g['series_ids'],start_time=g['start_time'],end_time=g.get('end_time','')))
        cats=[stage_class(s['protocol'],s['label']) for s in ss]
        drug=[i for i,x in enumerate(cats) if x=='drug / treatment']
        for pos,s in enumerate(ss):
            sc=cats[pos]
            relation='drug stage' if sc=='drug / treatment' else ('pre-drug' if drug and pos<min(drug) else ('post-drug' if drug else 'sequence stage'))
            recs=[r for r in catalog['records'] if r['series_id']==s['id']]
            channels=[]
            for r in recs:
                channel_id=r['channel_id']
                if channel_id not in [x['trace_id'] for x in channels]:
                    channels.append(dict(trace_id=channel_id,first=r))
            trace_ids=[x['trace_id'] for x in channels]
            for ch in channels:
                r=ch['first']
                traces.append(dict(trace_id=ch['trace_id'],file_id=r['file_id'],group_id=r['group_id'],series_id=r['series_id'],
                                   trace_index=r['trace_index'],trace_label=r['trace_label'],recording_mode=r['recording_mode'],
                                   is_current_monitor=not r['is_leak'],is_leak_trace=r['is_leak'],y_unit='A',sample_interval_s=r['dt_s']))
            series_recs=[r for r in recs if r['channel_id']==trace_ids[0]]
            medians=[]; clips=[]
            for tid in trace_ids:
                rs=[r for r in recs if r['channel_id']==tid]
                medians.append(float(np.nanmedian([r['late_pA'] for r in rs if r['late_pA'] is not None])) if any(r['late_pA'] is not None for r in rs) else None)
                clips.append(sum(bool(r['clip']) for r in rs))
            series.append(dict(file_id=s['file_id'],group_id=s['group_id'],series_id=s['id'],group_index=next(x['group_index'] for x in groups if x['group_id']==g['id']),
                series_index=s['index'],group_label=g['label'],series_label=s['label'],protocol_name=s['protocol'],stage_class=sc,stage_relation=relation,
                series_time=series_recs[0]['time'],group_time_min=s['start_min'],n_sweeps=s['n_sweeps'],n_traces=len(trace_ids),
                trace_labels=', '.join([t['trace_label'] for t in traces if t['series_id']==s['id']]),trace_ids=trace_ids,
                clip_sweeps_by_trace=clips,median_steady_by_trace_pA=medians,sample_interval_s=series_recs[0]['dt_s'],
                protocol_duration_s=sum(x['duration_s'] for x in series_recs[0]['segments']),segments=series_recs[0]['segments']))
            for r in recs:
                sweeps.append(dict(sweep_id=r['id'],file_id=r['file_id'],group_id=r['group_id'],series_id=r['series_id'],trace_id=r['channel_id'],
                    trace_label=r['trace_label'],sweep_index=r['sweep'],n_samples=r['n_samples'],time_s=r['display']['time_s'],value_pA=r['display']['value_pA'],
                    segments=r['segments'],sweep_label=r['sweep_label'],voltage_mV=r['voltage_mV'],
                    sweep_recorded_at=r['time'],group_elapsed_s=r['time_min']*60,time_source='HEKA Sweep.Time',
                    full_trace_url=r.get('full_trace_url',''),
                    metrics=dict(baseline_current_pA=r['baseline_pA'],pulse_steady_current_pA=r['late_pA'],tail_current_pA=None,
                                 activation_change_pA=r['delta_pA'],tail_change_pA=None,clip_metadata=r['clip'],quality_flag='CLIPPED_METADATA' if r['clip'] else 'OK',
                                 baseline_noise_sd_pA=r['baseline_sd_pA'],pulse_steady_noise_sd_pA=r['late_sd_pA'])))
    return dict(meta=dict(title='HEKA ephys recording explorer',raw_root_label='',n_files=len(catalog['files']),n_groups=len(groups),
                          n_series=len(series),n_trace_channels=len(traces),n_trace_sweeps=len(sweeps),downsample_max_points_per_sweep=600,
                          full_trace_export='',display_note='Interactive traces preserve segment boundaries and sweep labels. Selected traces can be exported at full resolution.'),
                files=file_payload,groups=groups,series=series,traces=traces,sweeps=sweeps,events=catalog['events'])

def decode_file(source, fid, raw_root, cache, progress=None):
    source=Path(source);raw_root=Path(raw_root);cache=Path(cache);cache.mkdir(parents=True,exist_ok=True)
    catalog=dict(version=2,files=[],groups=[],series=[],records=[],events=[])
    with Bundle(str(source)) as b:
        catalog['files'].append(dict(id=fid,name=source.name,path=str(source.relative_to(raw_root)),
            sha256=hashlib.sha256(source.read_bytes()).hexdigest(),version=b.header.Version))
        for gi,g in enumerate(b.pul.children,1):
            gid=f'{fid}_G{gi:02d}'
            sweep_times=[w.Time for s in g.children for w in s.children if w.children]
            if not sweep_times:continue
            origin=min(sweep_times)
            group=dict(id=gid,file_id=fid,index=gi,label=g.Label,text=g.Text,start_time=stamp(origin))
            catalog['groups'].append(group)
            active_event=None
            for si,s in enumerate(g.children,1):
                if not any(w.children for w in s.children):continue
                sid=f'{gid}_S{si:02d}'
                if progress: progress(f'{source.name} · Group {gi} / Series {si}')
                active_event=None
                name=b.pgf[s.children[0].StimCount-1].EntryName
                series=dict(id=sid,file_id=fid,group_id=gid,index=si,label=s.Label,comment=s.Comment,method=s.MethodName,
                    protocol=name,start_min=(s.children[0].Time-origin).total_seconds()/60,n_sweeps=len(s.children))
                catalog['series'].append(series)
                for wi,w in enumerate(s.children,1):
                    label=w.Label.strip()
                    event_source='sweep label'
                    if not label and wi==1 and s.Label!=name:
                        label=s.Label
                        event_source='series label'
                    if label:
                        active_event=dict(id=f'{sid}_W{wi:03d}',group_id=gid,series_id=sid,sweep=wi,label=label,
                            source=event_source,time_min=(w.Time-origin).total_seconds()/60)
                        catalog['events'].append(active_event)
                    for ti,t in enumerate(w.children,1):
                        rid=f'{sid}_W{wi:03d}_T{ti:02d}'
                        channel_id=f'{sid}_T{ti:02d}'
                        if t.YUnit!='A' or t.XStart!=0 or t.InterleaveSize!=0 or t.YOffset!=0:
                            raise ValueError(f'Unsupported trace encoding {rid}')
                        protocol,segs=protocol_for(b,w,t)
                        y=np.asarray(b.data[gi-1,si-1,wi-1,ti-1],dtype=np.float64)*1e12
                        if not len(y) or len(y)!=t.DataPoints or not np.isfinite(y).all():
                            raise ValueError(f"Invalid trace samples: {rid}")
                        np.save(cache/f'{rid}.npy',y,allow_pickle=False)
                        stored=[z for z in segs if z['stored']]
                        variable=[z for z in stored if z['increment_mV']]
                        target=variable[0]['index'] if variable else stored[min(2 if len(stored)==4 else 1,len(stored)-1)]['index']
                        baseline,noise,_=measurement(y,segs,stored[0]['index'],.1,.9)
                        late,late_sd,count=measurement(y,segs,target)
                        planned=sum(z['sample_end']-z['sample_start'] for z in stored)
                        if len(y)>planned: raise ValueError(f'Excess samples {rid}')
                        match=next(z for z in segs if z['index']==target)
                        rec=dict(id=rid,trace_id=channel_id,channel_id=channel_id,file_id=fid,group_id=gid,series_id=sid,sweep=wi,sweep_count=int(w.SweepCount),
                            sweep_label=w.Label,trace_index=ti,trace_label=t.Label,adc_channel=int(t.AdcChannel),
                            is_leak=bool(t.DataKind['IsLeak']),time=stamp(w.Time),time_min=(w.Time-origin).total_seconds()/60,
                            n_samples=len(y),dt_s=t.XInterval,segments=segs,default_segment=target,
                            voltage_mV=match['voltage_mV'],clip=bool(t.DataKind['Clip']),complete=len(y)==planned,
                            baseline_pA=baseline,baseline_sd_pA=noise,late_pA=late,late_sd_pA=late_sd,window_n=count,
                            delta_pA=None if late is None or baseline is None else late-baseline,
                            event_id=active_event['id'] if active_event else '',stage=active_event['label'] if active_event else '未标注',
                            stage_basis=('原始标记' if label else '沿用最近标记（推定）') if active_event else '未标注',
                            cslow_pF=t.CSlow*1e12,series_resistance_MOhm=1/t.GSeries/1e6 if t.GSeries>0 else None,
                            bandwidth_Hz=t.Bandwidth,seal_resistance_MOhm=t.SealResistance/1e6,
                            gain_A_per_count=t.DataScaler,recording_mode=t.RecordingMode)
                        times,_=coordinates(rec)
                        ix=display_indices(y,segs)
                        rec['display']=dict(sample_index=ix.tolist(),time_s=times[ix].round(8).tolist(),value_pA=y[ix].round(7).tolist())
                        catalog['records'].append(rec)
                series['end_min']=max(r['time_min']+r['n_samples']*r['dt_s']/60 for r in catalog['records'] if r['series_id']==sid)
            group['end_min']=max(r['time_min']+r['n_samples']*r['dt_s']/60 for r in catalog['records'] if r['group_id']==gid)
    return clean(catalog)
