/* Folder discovery stays on the loopback server; DAT files are not uploaded. */
function bindLibrary(){
  const input=$('libraryFolder'),scanButton=$('scanLibrary'),updateButton=$('updateLibrary');let polling=false;
  const request=async(path,body)=>{const response=await fetch('/api/library/'+path,{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Ephys-Request':'1'},body:JSON.stringify(body)}:{})});let data;try{data=await response.json();}catch(_){throw Error('请双击 Open_Ephys.cmd 启动支持文件夹更新的新版工作台。');}if(!response.ok)throw Error(data.error||'本地服务请求失败');return data;};
  const running=value=>{scanButton.disabled=value;updateButton.disabled=value;input.disabled=value;};
  const poll=async()=>{
    if(polling)return;polling=true;running(true);
    try{while(true){const job=await request('status');status('libraryStatus',job.message||'正在更新…',job.state==='error');if(job.state==='done'){saveWorkspace();if(!job.unchanged)location.reload();break;}if(job.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,800));}}
    catch(e){status('libraryStatus',e.message,true);}finally{polling=false;running(false);}
  };
  scanButton.onclick=async()=>{
    running(true);$('libraryScanDetails').hidden=true;status('libraryStatus','正在检索文件夹及子文件夹中的 DAT…');
    try{const data=await request('scan',{folder:input.value});input.value=data.folder;
      const body=$('libraryFiles').querySelector('tbody');body.replaceChildren();const labels={loaded:'已加载',new:'新增',changed:'已更改',duplicate:'相同内容副本'};
      for(const file of data.files){const tr=document.createElement('tr');tr.innerHTML=[file.relative_path,(file.size/1024/1024).toFixed(2)+' MB',labels[file.status]||file.status].map(text=>`<td>${esc(text)}</td>`).join('');body.append(tr);}
      $('libraryScanSummary').textContent=`扫描结果 · ${data.count} 个 DAT`; $('libraryScanDetails').hidden=false;
      status('libraryStatus',`找到 ${data.count} 个 DAT：已加载 ${data.loaded_count}，新增 ${data.new_count}，已更改 ${data.changed_count}。${data.count?'点击“更新文件列表”载入此文件夹。':'原列表未改变。'}`);
    }catch(e){status('libraryStatus',e.message,true);}finally{running(false);}
  };
  updateButton.onclick=async()=>{saveWorkspace();running(true);status('libraryStatus','开始扫描并更新；完成后自动载入，保留已保存的选择。');try{await request('update',{folder:input.value});await poll();}catch(e){status('libraryStatus',e.message,true);running(false);}};
  input.onkeydown=e=>{if(e.key==='Enter'&&!scanButton.disabled)scanButton.click();};
  input.oninput=()=>{$('libraryScanDetails').hidden=true;};
  request('config').then(config=>{input.value=config.folder;status('libraryStatus',`当前已加载 ${DATA.files.length} 个 DAT · ${DATA.groups.length} 个 Group`);if(config.job?.state==='running')poll();}).catch(e=>status('libraryStatus',e.message,true));
}
bindLibrary();
