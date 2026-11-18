"""Decode stored constant-segment HEKA recordings with per-sweep metadata."""
import numpy as np

def clean(obj):
    if isinstance(obj, dict): return {k:clean(v) for k,v in obj.items()}
    if isinstance(obj, (list, tuple)): return [clean(v) for v in obj]
    if isinstance(obj, np.integer): return int(obj)
    if isinstance(obj, (float,np.floating)): return float(obj) if np.isfinite(obj) else None
    if isinstance(obj, np.bool_): return bool(obj)
    return obj

def protocol_for(bundle, sweep, trace):
    pg = bundle.pgf[int(sweep.StimCount)-1]
    channels = [c for c in pg.children if c.LinkedChannel==trace.LinkDAChannel]
    if len(channels)!=1: raise ValueError('Ambiguous stimulus channel')
    ch=channels[0]
    if ch.StimToDacID['UseRelative'] or pg.DataStartTime!=0:
        raise ValueError('Relative stimulus or delayed acquisition requires additional decoding')
    segments, sample_start, elapsed = [],0,0.0
    for idx,s in enumerate(ch.children,1):
        if s.Class!='Constant' or s.VoltageSource!='Constant' or s.DurationSource!='Constant':
            raise ValueError('Unsupported stimulus segment')
        if s.VoltageIncMode!='Inc' or s.DeltaVFactor!=1 or s.DeltaTFactor!=1 or s.DeltaTIncrement!=0:
            raise ValueError('Unsupported voltage/duration increment')
        if s.StoreKind not in ('Store','NoStore'): raise ValueError('Unsupported storage mode')
        duration=float(s.Duration)
        voltage=round(float(s.Voltage+(sweep.SweepCount-1)*s.DeltaVIncrement)*1000,9)
        stored=s.StoreKind=='Store'
        n=round(duration/trace.XInterval) if stored else 0
        segments.append(dict(index=idx,start_s=elapsed,end_s=elapsed+duration,duration_s=duration,
                             voltage_mV=voltage,stored=stored,sample_start=sample_start,sample_end=sample_start+n,
                             increment_mV=float(s.DeltaVIncrement)*1000))
        elapsed+=duration
        sample_start+=n
    return pg.EntryName,segments

def measurement(y, segments, segment_index, start_fraction=.85, end_fraction=.95):
    seg=next((s for s in segments if s['index']==segment_index and s['stored']),None)
    if not seg: return None,None,0
    n=seg['sample_end']-seg['sample_start']
    lo=seg['sample_start']+round(n*start_fraction)
    hi=seg['sample_start']+round(n*end_fraction)
    if hi>len(y) or hi<=lo: return None,None,0
    values=y[lo:hi]
    return float(np.median(values)),float(np.std(values,ddof=1)) if len(values)>1 else 0.0,len(values)

def coordinates(record):
    n,dt=record['n_samples'],record['dt_s']
    times,voltage=np.full(n,np.nan),np.full(n,np.nan)
    for s in record['segments']:
        lo,hi=s['sample_start'],min(n,s['sample_end'])
        if not s['stored'] or hi<=lo: continue
        times[lo:hi]=s['start_s']+np.arange(hi-lo)*dt
        if not record['is_leak']: voltage[lo:hi]=s['voltage_mV']
    return times,voltage

def display_indices(y,segments,bins=600):
    indices=[0,len(y)-1]
    for block in np.array_split(np.arange(len(y)),min(bins,len(y))):
        vals=y[block]
        indices.extend([int(block[np.argmin(vals)]),int(block[np.argmax(vals)])])
    for s in segments: indices.extend([s['sample_start']-1,s['sample_start'],s['sample_end']-1])
    return np.unique(np.clip(indices,0,len(y)-1))
