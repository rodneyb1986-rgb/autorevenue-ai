const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const KEY='autorevenue_session';let token=sessionStorage.getItem(KEY)||'',state={opportunities:[],campaigns:[],content:[],revenue:[],approvals:[],activity:[],settings:{niche:'',monthlyGoal:500,autonomy:'approval',strategies:['affiliate','digital-products','lead-generation','content']}},generatedAsset='';
function money(n){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n)||0)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function headers(){return {'Content-Type':'application/json','Authorization':'Bearer '+token}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}}),j=await r.json().catch(()=>({}));if(r.status===401){logoutLocal();throw Error('Session expired. Sign in again.')}if(!r.ok)throw Error(j.error||'Request failed');return j}
function showLogin(){$('#login-screen').classList.remove('hidden');$('#app').classList.add('hidden')}
function showApp(){$('#login-screen').classList.add('hidden');$('#app').classList.remove('hidden')}
function logoutLocal(){token='';sessionStorage.removeItem(KEY);showLogin()}
async function loadState(){state=await api('/api/state');state.settings=state.settings||{};render();await checkSystem()}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='Signing in…';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#login-password').value})}),j=await r.json();if(!r.ok)throw Error(j.error||'Sign-in failed');token=j.token;sessionStorage.setItem(KEY,token);$('#login-password').value='';showApp();await loadState()}catch(err){$('#login-error').textContent=err.message}});
async function save(){await api('/api/state',{method:'PUT',body:JSON.stringify(state)});render()}
async function checkSystem(){try{const h=await fetch('/api/health').then(r=>r.json());$('#system-state').textContent=h.aiConfigured?'AI configured':'AI setup required';$('#system-state').className='status '+(h.aiConfigured?'ok':'warn');const items=[['Admin password',h.authConfigured],['OpenAI connection',h.aiConfigured],['PostgreSQL storage',h.persistentStorage]];$('#config-status').innerHTML=items.map(x=>'<div class="config"><strong>'+esc(x[0])+'</strong><small class="'+(x[1]?'ok':'warn')+'">'+(x[1]?'Configured':'Needs setup')+'</small></div>').join('')}catch{$('#system-state').textContent='Server check failed'}}
function view(name){$$('.view').forEach(x=>x.classList.add('hidden'));$('#view-'+name).classList.remove('hidden');$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===name));const names={dashboard:'Command Center',opportunities:'Opportunity Finder',content:'Content Studio',campaigns:'Campaign Planner',revenue:'Revenue & Profit',approvals:'Approval Queue',settings:'Settings'};$('#page-title').textContent=names[name]||'Command Center'}
$$('.nav').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view)));$$('[data-go]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.go)));$('#new-content').onclick=()=>view('content');
function addActivity(message){state.activity.unshift({message,at:new Date().toISOString()});state.activity=state.activity.slice(0,40)}
function record(title,body,status,actions){let buttons=actions.map(a=>'<button class="mini" data-action="'+a[1]+'">'+esc(a[0])+'</button>').join('');return '<div class="record"><div><strong>'+esc(title)+'</strong><p>'+esc(body||'')+'</p><small>'+esc(status||'')+'</small></div><div class="record-actions">'+buttons+'</div></div>'}
function render(){
 const income=state.revenue.filter(x=>x.type==='Income').reduce((a,x)=>a+Number(x.amount),0),expense=state.revenue.filter(x=>x.type==='Expense').reduce((a,x)=>a+Number(x.amount),0);
 $('#m-net').textContent=money(income-expense);$('#m-content').textContent=state.content.length;$('#m-ideas').textContent=state.opportunities.length;$('#m-approvals').textContent=state.approvals.filter(x=>x.status==='Pending').length;
 $('#activity').innerHTML=state.activity.length?state.activity.slice(0,8).map(x=>'<div class="activity-item">'+esc(x.message)+'<small>'+esc(new Date(x.at).toLocaleString())+'</small></div>').join(''):'<div class="empty">Your activity will appear here.</div>';
 $('#idea-list').innerHTML=state.opportunities.map((x,i)=>record(x.title,x.body||x.description||'',x.status||'Saved',[['Delete','delete-idea:'+i]])).join('')||'<div class="empty">No saved opportunities yet.</div>';
 $('#asset-list').innerHTML=state.content.map((x,i)=>record(x.title,x.body,x.status||'Draft',[['Request approval','approve-content:'+i],['Delete','delete-content:'+i]])).join('')||'<div class="empty">No saved content assets.</div>';
 $('#campaign-list').innerHTML=state.campaigns.map((x,i)=>record(x.name,x.channel+' · '+(x.goal||'No target')+' · '+x.duration+'\n'+(x.plan||''),x.status||'Planned',[['Request approval','approve-campaign:'+i],['Delete','delete-campaign:'+i]])).join('')||'<div class="empty">No campaign plans yet.</div>';
 $('#entry-list').innerHTML=state.revenue.slice().reverse().map(x=>record((x.type==='Income'?'+':'−')+money(x.amount)+' · '+x.source,x.date,x.type,[])).join('')||'<div class="empty">No transactions recorded.</div>';
 $('#approval-list').innerHTML=state.approvals.map((x,i)=>record(x.title,x.details||'',x.status,x.status==='Pending'?[['Approve','approve:'+i],['Reject','reject:'+i]]:[])).join('')||'<div class="empty">No approvals waiting.</div>';
 $('#setting-niche').value=state.settings.niche||'';$('#setting-goal').value=state.settings.monthlyGoal??500;$('#setting-autonomy').value=state.settings.autonomy||'approval';$$('.strategy').forEach(c=>c.checked=(state.settings.strategies||[]).includes(c.value));
 $$('[data-action]').forEach(b=>b.onclick=()=>handleAction(b.dataset.action));
}
async function handleAction(action){const parts=action.split(':'),kind=parts[0],i=Number(parts[1]);if(kind==='delete-idea')state.opportunities.splice(i,1);if(kind==='delete-content')state.content.splice(i,1);if(kind==='delete-campaign')state.campaigns.splice(i,1);if(kind==='approve-content'){const x=state.content[i];state.approvals.unshift({id:Date.now(),title:'Content: '+x.title,details:x.body,status:'Pending',created:new Date().toISOString()})}if(kind==='approve-campaign'){const x=state.campaigns[i];state.approvals.unshift({id:Date.now(),title:'Campaign: '+x.name,details:x.plan,status:'Pending',created:new Date().toISOString()})}if(kind==='approve'||kind==='reject'){state.approvals[i].status=kind==='approve'?'Approved':'Rejected';state.approvals[i].decidedAt=new Date().toISOString()}addActivity(kind.replaceAll('-',' ')+' updated');try{await save()}catch(e){alert(e.message)}}

$('#run-automation').addEventListener('click',runAutomation);
$('#logout').addEventListener('click',async()=>{try{if(token)await api('/api/logout',{method:'POST'})}catch{}finally{logoutLocal()}});

async function runAutomation(){
 const button=$('#run-automation'), output=$('#automation-result');
 button.disabled=true;button.textContent='Building plan…';output.classList.remove('hidden');output.textContent='AI is preparing an opportunity, campaign and content draft…';
 try{
  const r=await api('/api/automation/run',{method:'POST',body:JSON.stringify({niche:state.settings.niche,strategies:state.settings.strategies})});
  output.textContent='Created: '+r.created.opportunity+' · '+r.created.campaign+' · '+r.created.content+'\\n'+r.approvalsRequired+' items are waiting for your approval. Next step: '+r.nextStep;
  await loadState();
 }catch(e){output.textContent=e.message}
 finally{button.disabled=false;button.textContent='Run automation cycle'}
}

async function generate(type,prompt,niche,target){target.classList.remove('hidden');target.textContent='Working…';try{const r=await api('/api/generate',{method:'POST',body:JSON.stringify({type,prompt,niche})});target.textContent=r.result;return r.result}catch(e){target.textContent=e.message;return ''}}
$('#generate-ideas').onclick=async()=>{
 const niche=$('#idea-niche').value||state.settings.niche,strategy=$('#idea-strategy').value,focus=$('#idea-prompt').value,target=$('#idea-result');
 target.classList.remove('hidden');target.textContent='Analyzing opportunities and scoring validation potential…';
 const button=$('#generate-ideas');button.disabled=true;
 try{
  const r=await api('/api/opportunities/analyze',{method:'POST',body:JSON.stringify({niche,strategy,focus})});
  target.innerHTML='<p class="muted">'+esc(r.scoring)+'</p>'+r.opportunities.map((o,i)=>'<article class="record"><div><div class="panel-head"><strong>#'+(i+1)+' · '+esc(o.title)+'</strong><span class="tag">Score '+o.score+'/100</span></div><p><b>Customer:</b> '+esc(o.customer)+'</p><p><b>Problem:</b> '+esc(o.problem)+'</p><p><b>Offer:</b> '+esc(o.offer)+'</p><p><b>Monetization:</b> '+esc(o.monetization)+'</p><p><b>Estimated startup cost:</b> '+money(o.startupCostLow)+'–'+money(o.startupCostHigh)+' · <b>Validation:</b> '+o.validationDays+' days</p><p><b>Risk:</b> '+esc(o.mainRisk)+'</p><p><b>Validation steps:</b></p><ol>'+o.validationSteps.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol><small>'+esc(o.scoreBasis)+'</small></div></article>').join('');
  await loadState();
 }catch(e){target.textContent=e.message}
 finally{button.disabled=false;button.textContent='Generate shortlist'}
};
$('#generate-asset').onclick=async()=>{const prompt='Create a ready-to-edit '+$('#asset-type').value+'. Topic: '+$('#asset-prompt').value+'. Audience/niche: '+($('#asset-niche').value||state.settings.niche)+'. Include a clear value proposition and ethical call to action. Avoid unsupported claims.';generatedAsset=await generate('content asset',prompt,$('#asset-niche').value,$('#asset-result'));if(generatedAsset){$('#save-asset').classList.remove('hidden');$('#send-approval').classList.remove('hidden')}};
$('#save-asset').onclick=async()=>{state.content.unshift({id:Date.now(),title:$('#asset-prompt').value||$('#asset-type').value,type:$('#asset-type').value,body:generatedAsset,status:'Draft',created:new Date().toISOString()});addActivity('Saved a content draft');await save();$('#save-asset').classList.add('hidden');$('#send-approval').classList.add('hidden')};
$('#send-approval').onclick=async()=>{state.approvals.unshift({id:Date.now(),title:'Content review: '+($('#asset-prompt').value||$('#asset-type').value),details:generatedAsset,status:'Pending',created:new Date().toISOString()});addActivity('Submitted content for approval');await save();$('#send-approval').classList.add('hidden')};
$('#add-campaign').onclick=async()=>{const name=$('#campaign-name').value.trim();if(!name)return alert('Enter a campaign name.');state.campaigns.unshift({id:Date.now(),name,channel:$('#campaign-channel').value,goal:$('#campaign-goal').value,duration:$('#campaign-duration').value,plan:$('#campaign-plan').value,status:'Planned',created:new Date().toISOString()});addActivity('Created campaign plan: '+name);await save();$('#campaign-name').value='';$('#campaign-goal').value='';$('#campaign-plan').value=''};
$('#add-entry').onclick=async()=>{const amount=Number($('#entry-amount').value);if(!Number.isFinite(amount)||amount<=0)return alert('Enter an amount greater than zero.');state.revenue.push({id:Date.now(),type:$('#entry-type').value,amount,source:$('#entry-source').value||'Unspecified',date:$('#entry-date').value||new Date().toISOString().slice(0,10)});addActivity('Recorded '+$('#entry-type').value.toLowerCase()+' of '+money(amount));await save();$('#entry-amount').value='';$('#entry-source').value=''};
$('#save-settings').onclick=async()=>{state.settings={...state.settings,niche:$('#setting-niche').value,monthlyGoal:Number($('#setting-goal').value)||0,autonomy:$('#setting-autonomy').value,strategies:[...$$('.strategy:checked')].map(x=>x.value)};addActivity('Updated workspace settings');await save();alert('Settings saved.')};
async function start(){if(!token){showLogin();return}try{showApp();await loadState()}catch{showLogin()}}start();
