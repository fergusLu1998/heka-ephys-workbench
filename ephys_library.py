"""Transactional local DAT discovery and incremental decoding."""
from pathlib import Path
from assets import page_html
import csv,hashlib,json,re,shutil,threading,uuid
from datetime import datetime,timezone

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'outputs'
DEFAULT_FOLDER=''
COLLECTIONS=['files','groups','series','traces','sweeps','events']

def read_json(path):return json.loads(path.read_text(encoding='utf8'))
def digest(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

class Library:
    def __init__(self,out=OUT,project=ROOT):
        self.out=Path(out);self.project=Path(project);self.lock=threading.RLock()
        self.job=dict(state='idle',message='',completed=0,total=0)
        self.config_path=self.project/'library_config.json'
        try:self.folder=read_json(self.config_path)['folder']
        except (OSError,ValueError,KeyError):self.folder=DEFAULT_FOLDER

    def payload(self):return read_json(self.out/'ephys_platform_data.json')
    def status(self):
        with self.lock:return dict(self.job)
    def progress(self,**fields):
        with self.lock:self.job.update(fields)
    def config(self):return dict(service='heka-ephys-local',version=1,instance=hashlib.sha256(str(self.project.resolve()).encode()).hexdigest(),folder=self.folder,job=self.status())

    def scan(self,folder):
        base=Path(str(folder).strip()).expanduser()
        if not base.is_absolute():raise ValueError('请填写数据文件夹的完整路径。')
        base=base.resolve(strict=True)
        if not base.is_dir():raise ValueError('该路径不是文件夹。')
        current=self.payload();known={f['sha256']:f for f in current['files']};paths={f['relative_path'].replace('\\','/'):f for f in current['files']}
        rows=[];seen=set()
        for source in sorted(base.rglob('*'),key=lambda p:str(p).casefold()):
            if not source.is_file() or source.suffix.lower()!='.dat':continue
            if not source.resolve().is_relative_to(base):continue
            before=source.stat();sha=digest(source);after=source.stat()
            if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError(f'{source.name} 正在变化，请等待记录写入完成后重新扫描。')
            relative=source.relative_to(base).as_posix();old=known.get(sha)
            status='duplicate' if sha in seen else 'loaded' if old else 'changed' if relative in paths else 'new'
            rows.append(dict(relative_path=relative,name=source.name,size=after.st_size,mtime_ns=after.st_mtime_ns,sha256=sha,status=status,file_id=old['file_id'] if old else None))
            seen.add(sha)
        return dict(folder=str(base),files=rows,count=len(rows),unique_count=len(seen),new_count=sum(r['status']=='new' for r in rows),changed_count=sum(r['status']=='changed' for r in rows),loaded_count=sum(r['status']=='loaded' for r in rows))

    def start(self,folder):
        with self.lock:
            if self.job['state']=='running':raise ValueError('正在更新，请等待本次完成。')
            self.job=dict(state='running',message='正在扫描并核对 DAT 文件…',completed=0,total=0,id=uuid.uuid4().hex)
            thread=threading.Thread(target=self._worker,args=(folder,),daemon=True);thread.start()
            return dict(self.job)

    def _worker(self,folder):
        stage=None
        try:
            from heka_reader import decode_file,legacy_payload
            scan=self.scan(folder);base=Path(scan['folder']);rows=[r for r in scan['files'] if r['status']!='duplicate']
            if not rows:raise ValueError('目录中没有 DAT 文件；原始文件列表未改变。')
            old=self.payload();known={f['sha256']:f for f in old['files']}
            registry_path=self.project/'library_file_ids.json'
            registry=read_json(registry_path) if registry_path.exists() else {}
            registry.update({f['sha256']:f['file_id'] for f in old['files']})
            next_index=max([int(re.match(r'F(\d+)',fid)[1]) for fid in registry.values() if re.match(r'F(\d+)',fid)]+[0])+1
            job_id=self.status()['id'];stage_root=self.out/'library_staging';stage=stage_root/job_id;stage.mkdir(parents=True)
            merged={key:[] for key in COLLECTIONS};new_catalogs=[];imported=0
            self.progress(total=len(rows))
            for number,row in enumerate(rows,1):
                self.progress(message=f"{number}/{len(rows)} · {row['name']}")
                source=base/row['relative_path'];existing=known.get(row['sha256'])
                if existing:
                    fid=existing['file_id']
                    for key in COLLECTIONS:
                        if key=='events':items=[e for e in old[key] if e['group_id'].startswith(fid+'_G')]
                        else:items=[e for e in old[key] if e.get('file_id')==fid]
                        merged[key].extend(dict(e) for e in items)
                    merged['files'][-1]['relative_path']=row['relative_path'];merged['files'][-1]['file_name']=row['name']
                else:
                    stem=''.join(c if c.isascii() and c.isalnum() else '_' for c in source.stem).strip('_') or 'recording'
                    fid=registry.get(row['sha256'])
                    if not fid:fid=f'F{next_index:02d}_{stem}_{row["sha256"][:8]}';next_index+=1
                    registry[row['sha256']]=fid
                    catalog=decode_file(source,fid,base,stage/'raw'/fid,lambda msg:self.progress(message=msg))
                    if not catalog['records']:raise ValueError(f'{source.name} 中没有可加载的 trace。')
                    after=source.stat()
                    if after.st_size!=row['size'] or after.st_mtime_ns!=row['mtime_ns'] or digest(source)!=row['sha256']:raise ValueError(f'{source.name} 在解析期间发生变化，请重新扫描。')
                    part=legacy_payload(catalog)
                    for sweep in part['sweeps']:sweep['raw_url']=f"trace_imports/{job_id}/{fid}/{sweep['sweep_id']}.npy"
                    for key in COLLECTIONS:merged[key].extend(part[key])
                    new_catalogs.append(catalog);imported+=1
                self.progress(completed=number)
            merged['files'].sort(key=lambda f:int(re.match(r'F(\d+)',f['file_id'])[1]))
            merged['meta']=dict(old['meta'],raw_root_label=base.name,raw_root_path=str(base),n_files=len(merged['files']),n_groups=len(merged['groups']),n_series=len(merged['series']),n_trace_channels=len(merged['traces']),n_trace_sweeps=len(merged['sweeps']),full_trace_export='',display_note='Full-resolution samples are served locally and exported from the selected-trace controls.')
            if (stage/'raw').exists():
                target=self.out/'trace_imports'/job_id;target.parent.mkdir(exist_ok=True);(stage/'raw').rename(target)
            for sweep in merged['sweeps']:
                if not (self.out/sweep.get('raw_url',f"trace_cache/{sweep['sweep_id']}.npy")).is_file():raise ValueError(f"缺少原始采样缓存：{sweep['sweep_id']}")
            if not imported and merged['files']==old['files'] and old['meta'].get('raw_root_path')==str(base):
                self.progress(state='done',message=f"列表已是最新：{len(merged['files'])} 个 DAT。",files=len(merged['files']),groups=len(merged['groups']),imported=0,unchanged=True)
                return
            self.progress(message='正在发布更新后的原始文件列表…')
            registry_path.write_text(json.dumps(registry,ensure_ascii=False,indent=2),encoding='utf8')
            self.publish(merged,new_catalogs,stage)
            self.folder=str(base)
            try:self.config_path.write_text(json.dumps(dict(folder=self.folder),ensure_ascii=False,indent=2),encoding='utf8')
            except OSError:self.progress(warning='数据已更新，但未能记住数据文件夹路径。')
            self.progress(state='done',message=f"已更新：{len(merged['files'])} 个 DAT，新增解析 {imported} 个文件，{len(merged['groups'])} 个 Group。",files=len(merged['files']),groups=len(merged['groups']),imported=imported)
        except Exception as error:
            self.progress(state='error',message=f'更新未完成，原列表保留：{type(error).__name__}: {error}')
        finally:
            if stage and stage.exists():
                assert stage.resolve().is_relative_to((self.out/'library_staging').resolve())
                shutil.rmtree(stage)

    def publish(self,data,new_catalogs,stage):
        encoded=json.dumps(data,ensure_ascii=False,allow_nan=False,separators=(',',':'))
        (stage/'ephys_platform_data.json').write_text(encoded,encoding='utf8')
        (stage/'ephys_platform.html').write_text(page_html(self.project,encoded),encoding='utf8')
        live_ids={s['sweep_id'] for s in data['sweeps']};summary=[]
        summary_path=self.out/'ephys_all_sweep_summary.csv'
        if summary_path.exists():
            with summary_path.open(encoding='utf-8-sig',newline='') as stream:summary=[r for r in csv.DictReader(stream) if r['id'] in live_ids]
        for catalog in new_catalogs:
            by_series={s['id']:s for s in catalog['series']};by_group={g['id']:g for g in catalog['groups']}
            for r in catalog['records']:
                row={k:v for k,v in r.items() if k not in ['display','segments']};s=by_series[r['series_id']]
                row.update(protocol_name=s['protocol'],series_label=s['label'],series_comment=s['comment'],method=s['method'],group_label=by_group[r['group_id']]['label']);summary.append(row)
        def write_csv(name,rows):
            keys=list(dict.fromkeys(k for row in rows for k in row))
            with (stage/name).open('w',encoding='utf-8-sig',newline='') as stream:
                writer=csv.DictWriter(stream,keys);writer.writeheader();writer.writerows(rows)
        write_csv('ephys_all_sweep_summary.csv',summary)
        for collection,name in [('files','ephys_file_index.csv'),('groups','ephys_all_group_index.csv'),('series','ephys_all_series_metadata.csv'),('events','ephys_stage_events.csv')]:write_csv(name,data[collection])
        names=['ephys_platform_data.json','ephys_all_sweep_summary.csv','ephys_file_index.csv','ephys_all_group_index.csv','ephys_all_series_metadata.csv','ephys_stage_events.csv','ephys_platform.html']
        backup=self.project/'backups'/f"library_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{self.status()['id'][:8]}";backup.mkdir(parents=True)
        for name in names:
            if (self.out/name).exists():shutil.copy2(self.out/name,backup/name)
        replaced=[]
        try:
            for name in names:(stage/name).replace(self.out/name);replaced.append(name)
        except Exception:
            for name in reversed(replaced):
                if (backup/name).exists():shutil.copy2(backup/name,self.out/name)
            raise
