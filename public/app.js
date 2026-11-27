const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const KEY='autorevenue_session';let token=sessionStorage.getItem(KEY)||'',state={opportunities:[],campaigns:[],content:[],revenue:[],approvals:[],activity:[],settings:{niche:'',monthlyGoal:500,autonomy:'approval',strategies:['affiliate','digital-products','lead-generation','content']}},generatedAsset='',generatedGolfPitch='';
function money(n){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n)||0)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function headers(){return {'Content-Type':'application/json','Authorization':'Bearer '+token}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}}),j=await r.json().catch(()=>({}));if(r.status===401){logoutLocal();throw Error('Session expired. Sign in again.')}if(!r.ok)throw Error(j.error||'Request failed');return j}
function showLogin(){$('#login-screen').classList.remove('hidden');$('#app').classList.add('hidden')}
function showApp(){$('#login-screen').classList.add('hidden');$('#app').classList.remove('hidden')}
function logoutLocal(){token='';sessionStorage.removeItem(KEY);showLogin()}
async function loadState(){state=await api('/api/state');state.settings=state.settings||{};render();await checkSystem();await verifyCheckoutReturn()}
async function verifyCheckoutReturn(){
 const url=new URL(window.location.href),checkout=url.searchParams.get('checkout');
 if(!checkout)return;
 const sessionId=url.searchParams.get('session_id');
 url.searchParams.delete('checkout');url.searchParams.delete('session_id');
 window.history.replaceState({},'',url.pathname+url.search+url.hash);
 const out=$('#commerce-result');out.classList.remove('hidden');
 if(checkout==='cancelled'){out.textContent='Checkout was cancelled. No payment was recorded.';return;}
 if(checkout!=='success'){out.textContent='Unknown checkout return status.';return;}
 if(!sessionId){out.textContent='Stripe returned success without a checkout session ID. No payment has been assumed.';return;}
 out.textContent='Verifying payment directly with Stripe…';
 try{
  const result=await api('/api/commerce/checkout-session?session_id='+encodeURIComponent(sessionId));
  if(result.verified){
   state=await api('/api/state');state.settings=state.settings||{};render();
   out.textContent='Payment verified by Stripe. '+(result.order?.productName||'Your order')+' · '+money(result.order?.amountTotal)+' '+(result.order?.currency||'USD')+'. The order and revenue ledger are up to date.';
  }else{
   out.textContent='Stripe has not marked this checkout as paid yet ('+(result.paymentStatus||'pending')+'). No revenue or access has been granted. Refresh this page in a moment or check the webhook delivery.';
  }
 }catch(error){out.textContent='Payment verification could not be completed: '+error.message+'. No payment is assumed from the success URL alone.';}
}
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();$('#login-error').textContent='Signing in…';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('#login-password').value})}),j=await r.json();if(!r.ok)throw Error(j.error||'Sign-in failed');token=j.token;sessionStorage.setItem(KEY,token);$('#login-password').value='';showApp();await loadState()}catch(err){$('#login-error').textContent=err.message}});
async function save(){await api('/api/state',{method:'PUT',body:JSON.stringify(state)});render()}
async function checkSystem(){try{const h=await fetch('/api/health').then(r=>r.json());$('#system-state').textContent=h.aiConfigured?'AI configured':'AI setup required';$('#system-state').className='status '+(h.aiConfigured?'ok':'warn');const items=[['Admin password',h.authConfigured],['OpenAI connection',h.aiConfigured],['PostgreSQL storage',h.storageReady&&h.persistentStorage],['Stripe test key',h.stripeTestConfigured],['Stripe webhook',h.stripeWebhookConfigured],['Automatic delivery email',h.emailDeliveryConfigured]];$('#config-status').innerHTML=items.map(x=>'<div class="config"><strong>'+esc(x[0])+'</strong><small class="'+(x[1]?'ok':'warn')+'">'+(x[1]?'Configured':'Needs setup')+'</small></div>').join('')}catch{$('#system-state').textContent='Server check failed'}}
$('#test-ai').addEventListener('click',async()=>{
 const button=$('#test-ai'),status=$('#ai-test-result');
 button.disabled=true;status.textContent='Testing OpenAI connection…';
 try{
  const result=await api('/api/ai/test',{method:'POST',body:JSON.stringify({})});
  status.textContent='Connected · '+result.model;
  status.className='ok';
 }catch(error){
  status.textContent=error.message;
  status.className='warn';
 }finally{button.disabled=false}
});
function view(name){$$('.view').forEach(x=>x.classList.add('hidden'));$('#view-'+name).classList.remove('hidden');$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===name));const names={dashboard:'Command Center',opportunities:'Opportunity Finder',content:'Content Studio',campaigns:'Campaign Planner',revenue:'Revenue & Profit',approvals:'Approval Queue',golf:'Golf Gear Opportunities',commerce:'Products & Checkout',settings:'Settings'};$('#page-title').textContent=names[name]||'Command Center'}
$$('.nav').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view)));$$('[data-go]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.go)));$('#new-content').onclick=()=>view('content');
function addActivity(message){state.activity.unshift({message,at:new Date().toISOString()});state.activity=state.activity.slice(0,40)}
function record(title,body,status,actions){let buttons=actions.map(a=>'<button class="mini" data-action="'+a[1]+'">'+esc(a[0])+'</button>').join('');return '<div class="record"><div><strong>'+esc(title)+'</strong><p>'+esc(body||'')+'</p><small>'+esc(status||'')+'</small></div><div class="record-actions">'+buttons+'</div></div>'}
function render(){
 const income=state.revenue.filter(x=>x.type==='Income').reduce((a,x)=>a+Number(x.amount),0),expense=state.revenue.filter(x=>x.type==='Expense').reduce((a,x)=>a+Number(x.amount),0);
 $('#m-net').textContent=money(income-expense);$('#m-content').textContent=state.content.length;$('#m-ideas').textContent=state.opportunities.length;$('#m-approvals').textContent=state.approvals.filter(x=>x.status==='Pending').length;const digitalOrders=(state.orders||[]).filter(x=>x.paymentStatus==='paid'&&x.deliveryToken);const emailSent=digitalOrders.filter(x=>x.deliveryEmailStatus==='sent').length;const emailNeedsAttention=digitalOrders.length-emailSent;$('#m-email').textContent=emailSent+' / '+digitalOrders.length;$('#m-email-note').textContent=digitalOrders.length?emailNeedsAttention+' need attention':'No paid digital orders yet';
 $('#activity').innerHTML=state.activity.length?state.activity.slice(0,8).map(x=>'<div class="activity-item">'+esc(x.message)+'<small>'+esc(new Date(x.at).toLocaleString())+'</small></div>').join(''):'<div class="empty">Your activity will appear here.</div>';
 $('#idea-list').innerHTML=state.opportunities.map((x,i)=>record(x.title,x.body||x.description||'',x.status||'Saved',[['Delete','delete-idea:'+i]])).join('')||'<div class="empty">No saved opportunities yet.</div>';
 $('#asset-list').innerHTML=state.content.map((x,i)=>record(x.title,x.body,x.status||'Draft',[['Request approval','approve-content:'+i],['Delete','delete-content:'+i]])).join('')||'<div class="empty">No saved content assets.</div>';
 $('#campaign-list').innerHTML=state.campaigns.map((x,i)=>{const m=x.metrics||[],sum=k=>m.reduce((a,v)=>a+Number(v[k]||0),0);return record(x.name,x.channel+' · '+(x.goal||'No target')+' · '+x.duration+'\\n'+(x.plan||'')+'\\nSnapshots: '+m.length+' · Clicks: '+sum('clicks')+' · Leads: '+sum('leads')+' · Sales: '+sum('conversions')+' · Spend: '+money(sum('spend'))+' · Attributed revenue: '+money(sum('revenue'))+' · Net: '+money(sum('revenue')-sum('spend')),x.status||'Planned',[['Create content brief','content-from-campaign:'+x.id],['Request approval','approve-campaign:'+i],['Delete','delete-campaign:'+i]])}).join('')||'<div class="empty">No campaign plans yet.</div>';
 const metricSelect=$('#metric-campaign');if(metricSelect){const selected=metricSelect.value;metricSelect.innerHTML='<option value="">Select a campaign</option>'+state.campaigns.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');metricSelect.value=selected;}
 const summary=$('#campaign-metrics-summary');if(summary){const c=state.campaigns.find(x=>String(x.id)===String(metricSelect?.value));if(c){const m=c.metrics||[],sum=k=>m.reduce((a,v)=>a+Number(v[k]||0),0),imp=sum('impressions'),clicks=sum('clicks'),leads=sum('leads'),sales=sum('conversions'),spend=sum('spend'),rev=sum('revenue');summary.textContent='Snapshots: '+m.length+' · CTR: '+(imp?(clicks/imp*100).toFixed(2):'0.00')+'% · Lead rate: '+(clicks?(leads/clicks*100).toFixed(2):'0.00')+'% · Conversion rate: '+(clicks?(sales/clicks*100).toFixed(2):'0.00')+'% · ROI: '+(spend?((rev-spend)/spend*100).toFixed(1):'—')+'% · Net: '+money(rev-spend)}else summary.textContent='Select a campaign to view its performance summary.'}
 const campaignSpend=state.campaigns.reduce((a,c)=>a+(c.metrics||[]).reduce((n,m)=>n+Number(m.spend||0),0),0),campaignRevenue=state.campaigns.reduce((a,c)=>a+(c.metrics||[]).reduce((n,m)=>n+Number(m.revenue||0),0),0);
 const monthKey=new Date().toISOString().slice(0,7),monthIncome=state.revenue.filter(x=>x.type==='Income'&&String(x.date||'').startsWith(monthKey)).reduce((n,x)=>n+Number(x.amount||0),0),monthExpense=state.revenue.filter(x=>x.type==='Expense'&&String(x.date||'').startsWith(monthKey)).reduce((n,x)=>n+Number(x.amount||0),0),monthNet=monthIncome-monthExpense,goal=Math.max(0,Number(state.settings.monthlyGoal||0)),goalPct=goal?Math.max(0,Math.min(100,monthNet/goal*100)):0;
 $('#month-income').textContent=money(monthIncome);$('#month-expenses').textContent=money(monthExpense);$('#month-net').textContent=money(monthNet);$('#month-goal').textContent=goal?money(goal):'Not set';$('#month-goal-progress').textContent=goal?goalPct.toFixed(1)+'% of monthly net goal':'Set a monthly goal in Settings';$('#month-goal-bar').style.width=goal?goalPct+'%':'0%';
 $('#actual-income').textContent=money(income);$('#actual-expenses').textContent=money(expense);$('#actual-net').textContent=money(income-expense);$('#campaign-attributed').textContent=money(campaignRevenue);$('#campaign-spend').textContent=money(campaignSpend);$('#campaign-net').textContent=money(campaignRevenue-campaignSpend);
 $('#entry-list').innerHTML=state.revenue.slice().reverse().map(x=>record((x.type==='Income'?'+':'−')+money(x.amount)+' · '+x.source,x.date,x.type,[])).join('')||'<div class="empty">No transactions recorded.</div>';
 const stripeList=$('#stripe-transaction-list');if(stripeList&&!stripeList.dataset.loaded)stripeList.innerHTML='<div class="empty">Select Refresh Stripe transactions to load the latest records from Stripe.</div>';
 $('#golf-list').innerHTML=(state.golfOpportunities||[]).map((x,i)=>record(x.brand+' · '+x.type,x.equipment+'\\n'+(x.notes||'')+'\\n'+(x.url||''),'<select class="golf-status" data-golf-status="'+esc(x.id)+'">'+['To research','Eligible','Application drafted','Applied (manual)','Follow-up','Accepted','Declined','Received'].map(v=>'<option'+((x.status||'To research')===v?' selected':'')+'>'+v+'</option>').join('')+'</select>',[['Delete','golf-delete:'+i]])).join('')||'<div class="empty">No golf gear opportunities saved yet.</div>';
 $('#commerce-list').innerHTML=(state.products||[]).map((x,i)=>record(x.name,(x.type==='physical'?'Physical':'Digital')+' · '+(x.billing==='subscription'?'Subscription · '+x.interval:'One-time')+' · '+money(x.amount),x.active?'Active':'Inactive',[['Create test checkout','commerce-checkout:'+x.id]])).join('')||'<div class="empty">No products created yet.</div>';
 $('#commerce-orders').innerHTML=(state.orders||[]).map(order=>{
  const details=(order.customerEmail||'No customer email')+' · '+money(order.amountTotal)+' '+esc(order.currency||'USD')+' · '+(order.mode==='subscription'?'Subscription':'One-time');
  const emailState=order.deliveryEmailStatus||'not sent';
  const emailStatus=order.deliveryToken?' · Email: '+emailState:'';
  const status=(order.paymentStatus||'unknown')+' · Fulfillment: '+(order.fulfillmentStatus||'pending')+emailStatus;
  const emailMeta=order.deliveryToken?'<small class="delivery-email-meta">'+(emailState==='sent'?'Email submitted to Resend'+(order.deliveryEmailSentAt?' · '+esc(new Date(order.deliveryEmailSentAt).toLocaleString()):''):emailState==='failed'?'Email failed · '+esc(order.deliveryEmailError||'No provider details'):'Email has not been sent yet')+'</small>':'';
  const action=order.paymentStatus==='paid'&&order.fulfillmentStatus!=='fulfilled'?[['Mark fulfilled','commerce-fulfill:'+order.id]]:[];
  if(order.deliveryToken&&order.paymentStatus==='paid'&&emailState!=='sent')action.push(['Retry delivery email','commerce-email-retry:'+order.id]);
  const delivery=order.deliveryToken
   ? '<div class="download-row"><a class="btn secondary" href="/download/'+encodeURIComponent(order.deliveryToken)+'" target="_blank" rel="noopener">Download digital product</a><button class="mini" type="button" data-copy-download="'+esc(location.origin+'/download/'+order.deliveryToken)+'">Copy download link</button></div>'
   : '';
  return '<div class="record"><div><strong>'+esc(order.productName||'Stripe order')+'</strong><p>'+details+'</p><small>'+esc(status)+'</small>'+emailMeta+delivery+'</div><div class="record-actions">'+action.map(a=>'<button class="mini" data-action="'+esc(a[1])+'">'+esc(a[0])+'</button>').join('')+'</div></div>';
 }).join('')||'<div class="empty">No Stripe orders received yet. Completed payments will appear here after the webhook is delivered.</div>';
 $('#approval-list').innerHTML=state.approvals.map((x,i)=>record(x.title,x.details||'',x.status,x.status==='Pending'?[['Approve','approve:'+i],['Reject','reject:'+i]]:[])).join('')||'<div class="empty">No approvals waiting.</div>';
 const aiRows=Array.isArray(state.aiUsage)?state.aiUsage:[],today=new Date().toISOString().slice(0,10),month=today.slice(0,7),todayRows=aiRows.filter(x=>String(x.createdAt||'').startsWith(today)),monthRows=aiRows.filter(x=>String(x.createdAt||'').startsWith(month)),tokens=rows=>rows.reduce((n,x)=>n+Number(x.totalTokens||0),0);
 const usageBox=$('#ai-usage-summary');if(usageBox)usageBox.textContent='Today: '+todayRows.length+' requests · '+tokens(todayRows).toLocaleString()+' tokens | This month: '+monthRows.length+' requests · '+tokens(monthRows).toLocaleString()+' tokens. Token totals are reported by the API; dollar cost is not estimated here.';
 $('#setting-niche').value=state.settings.niche||'';$('#setting-goal').value=state.settings.monthlyGoal??500;$('#setting-autonomy').value=state.settings.autonomy||'approval';$$('.strategy').forEach(c=>c.checked=(state.settings.strategies||[]).includes(c.value));
 $$('[data-action]').forEach(b=>b.onclick=()=>handleAction(b.dataset.action));
}
async function handleAction(action){const parts=action.split(':'),kind=parts[0],i=Number(parts[1]);if(kind==='campaign-from-idea'){const idea=state.opportunities.find(x=>String(x.id)===String(parts[1]));if(idea){state.campaigns.unshift({id:Date.now(),name:'Validation: '+idea.title,channel:'Website / blog',goal:'Validate demand for '+idea.offer,duration:(idea.validationDays||14)+' days',plan:'Target customer: '+(idea.customer||'To define')+'\\nProblem: '+(idea.problem||'')+'\\nOffer: '+(idea.offer||'')+'\\nMonetization hypothesis: '+(idea.monetization||'')+'\\nValidation steps: '+(idea.validationSteps||[]).join(' | ')+'\\nMain risk: '+(idea.mainRisk||'')+'\\nAI score: '+(idea.score??'N/A')+'/100; hypothesis only.',status:'Draft · validation required',sourceOpportunityId:idea.id,created:new Date().toISOString()});view('campaigns');}} if(kind==='content-from-campaign'){const campaign=state.campaigns.find(x=>String(x.id)===String(parts[1]));if(campaign){const brief='CAMPAIGN: '+campaign.name+'\\nCHANNEL: '+(campaign.channel||'To decide')+'\\nGOAL: '+(campaign.goal||'')+'\\nAUDIENCE / OFFER / PLAN:\\n'+(campaign.plan||'')+'\\n\\nCreate useful, truthful content that supports this campaign goal. Include a clear call to action, but do not invent product claims, customer results, pricing, or guarantees. Treat this as a draft for human review.';state.content.unshift({id:Date.now(),title:'Content brief: '+campaign.name,type:'Campaign content brief',body:brief,status:'Draft',campaignId:campaign.id,created:new Date().toISOString()});addActivity('Created content brief for '+campaign.name);view('content');}} if(kind==='delete-idea')state.opportunities.splice(i,1);if(kind==='delete-content')state.content.splice(i,1);if(kind==='delete-campaign')state.campaigns.splice(i,1);if(kind==='approve-content'){const x=state.content[i];state.approvals.unshift({id:Date.now(),title:'Content: '+x.title,details:x.body,status:'Pending',created:new Date().toISOString()})}if(kind==='approve-campaign'){const x=state.campaigns[i];state.approvals.unshift({id:Date.now(),title:'Campaign: '+x.name,details:x.plan,status:'Pending',created:new Date().toISOString()})}if(kind==='approve'||kind==='reject'){state.approvals[i].status=kind==='approve'?'Approved':'Rejected';state.approvals[i].decidedAt=new Date().toISOString()}if(kind==='golf-delete'){state.golfOpportunities.splice(i,1)}if(kind==='golf-applied'){state.golfOpportunities[i].status='Application prepared / submitted manually';state.golfOpportunities[i].updatedAt=new Date().toISOString()}addActivity(kind.replaceAll('-',' ')+' updated');try{await save()}catch(e){alert(e.message)}}

$('#run-automation').addEventListener('click',runAutomation);
$('#logout').addEventListener('click',async()=>{try{if(token)await api('/api/logout',{method:'POST'})}catch{}finally{logoutLocal()}});

async function runAutomation(){
 const button=$('#run-automation'), output=$('#automation-result');
 button.disabled=true;button.textContent='Building plan…';output.classList.remove('hidden');output.textContent='AI is preparing an opportunity, campaign and content draft…';
 try{
  const r=await api('/api/automation/run',{method:'POST',body:JSON.stringify({niche:state.settings.niche,strategies:state.settings.strategies})});
  output.textContent='Created: '+r.created.opportunity+' · '+r.created.campaign+' · '+r.created.content+'\\nNo external actions were taken. Drafts are saved for the next step: '+r.nextStep;
  await loadState();
 }catch(e){output.textContent=e.message}
 finally{button.disabled=false;button.textContent='Run automation cycle'}
}

async function generate(type,prompt,niche,target){target.classList.remove('hidden');target.textContent='Working…';try{const r=await api('/api/generate',{method:'POST',body:JSON.stringify({type,prompt,niche})});target.textContent=r.result;return r.result}catch(e){target.textContent=e.message;return ''}}
$('#idea-result').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)handleAction(b.dataset.action)});
$('#generate-ideas').onclick=async()=>{
 const niche=$('#idea-niche').value||state.settings.niche,strategy=$('#idea-strategy').value,focus=$('#idea-prompt').value,target=$('#idea-result');
 target.classList.remove('hidden');target.textContent='Analyzing opportunities and scoring validation potential…';
 const button=$('#generate-ideas');button.disabled=true;
 try{
  const r=await api('/api/opportunities/analyze',{method:'POST',body:JSON.stringify({niche,strategy,focus})});
  target.innerHTML='<p class="muted">'+esc(r.scoring)+'</p>'+r.opportunities.map((o,i)=>'<article class="record"><div><div class="panel-head"><strong>#'+(i+1)+' · '+esc(o.title)+'</strong><span class="tag">Score '+o.score+'/100</span></div><p><b>Customer:</b> '+esc(o.customer)+'</p><p><b>Problem:</b> '+esc(o.problem)+'</p><p><b>Offer:</b> '+esc(o.offer)+'</p><p><b>Monetization:</b> '+esc(o.monetization)+'</p><p><b>Estimated startup cost:</b> '+money(o.startupCostLow)+'–'+money(o.startupCostHigh)+' · <b>Validation:</b> '+o.validationDays+' days</p><p><b>Risk:</b> '+esc(o.mainRisk)+'</p><p><b>Validation steps:</b></p><ol>'+o.validationSteps.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol><small>'+esc(o.scoreBasis)+'</small><div class="button-row"><button class="btn secondary" data-action="campaign-from-idea:'+esc(o.id)+'">Build validation campaign</button></div></div></article>').join('');
  await loadState();
 }catch(e){target.textContent=e.message}
 finally{button.disabled=false;button.textContent='Generate shortlist'}
};
$('#generate-asset').onclick=async()=>{const prompt='Create a ready-to-edit '+$('#asset-type').value+'. Topic: '+$('#asset-prompt').value+'. Audience/niche: '+($('#asset-niche').value||state.settings.niche)+'. Include a clear value proposition and ethical call to action. Avoid unsupported claims.';generatedAsset=await generate('content asset',prompt,$('#asset-niche').value,$('#asset-result'));if(generatedAsset){$('#save-asset').classList.remove('hidden');$('#send-approval').classList.remove('hidden')}};
$('#save-asset').onclick=async()=>{state.content.unshift({id:Date.now(),title:$('#asset-prompt').value||$('#asset-type').value,type:$('#asset-type').value,body:generatedAsset,status:'Draft',created:new Date().toISOString()});addActivity('Saved a content draft');await save();$('#save-asset').classList.add('hidden');$('#send-approval').classList.add('hidden')};
$('#send-approval').onclick=async()=>{state.approvals.unshift({id:Date.now(),title:'Content review: '+($('#asset-prompt').value||$('#asset-type').value),details:generatedAsset,status:'Pending',created:new Date().toISOString()});addActivity('Submitted content for approval');await save();$('#send-approval').classList.add('hidden')};
$('#golf-list').addEventListener('change',async e=>{const select=e.target.closest('[data-golf-status]');if(!select)return;const item=(state.golfOpportunities||[]).find(x=>String(x.id)===String(select.dataset.golfStatus));if(!item)return;item.status=select.value;item.updatedAt=new Date().toISOString();addActivity('Updated golf opportunity status: '+item.brand+' · '+item.status);try{await save()}catch(err){alert(err.message)}});
$('#golf-add').onclick=async()=>{
 const brand=$('#golf-brand').value.trim(),equipment=$('#golf-equipment').value.trim();if(!brand)return alert('Enter a brand or opportunity name.');
 state.golfOpportunities=Array.isArray(state.golfOpportunities)?state.golfOpportunities:[];
 state.golfOpportunities.unshift({id:Date.now(),brand,type:$('#golf-type').value,equipment,url:$('#golf-url').value.trim(),notes:$('#golf-notes').value.trim(),status:'To research',created:new Date().toISOString()});
 addActivity('Saved golf gear opportunity: '+brand);await save();['golf-brand','golf-equipment','golf-url','golf-notes'].forEach(id=>$('#'+id).value='');
};
$('#golf-generate').onclick=async()=>{
 const brand=$('#golf-brand').value.trim()||'the selected golf equipment program',equipment=$('#golf-equipment').value.trim()||'golf equipment';
 const prompt='Draft a truthful, personalized application or product-testing pitch to '+brand+'. Equipment of interest: '+equipment+'. Playing level: '+$('#golf-level').value+'. Review/content experience: '+$('#golf-experience').value+'. Why I am a good fit: '+$('#golf-pitch-notes').value+'. Ask about eligibility and terms. Do not invent followers, handicap, prior endorsements, results, or credentials. Keep it concise and disclose that any review would be honest and independent.';
 generatedGolfPitch=await generate('golf product testing / ambassador application',prompt,'Golf equipment product testing',$('#golf-pitch-result'));if(generatedGolfPitch)$('#golf-save-pitch').classList.remove('hidden');
};
$('#golf-save-pitch').onclick=async()=>{
 state.content.unshift({id:Date.now(),title:'Golf equipment application pitch',type:'Application draft',body:generatedGolfPitch,status:'Draft · not submitted',created:new Date().toISOString()});
 addActivity('Saved golf equipment application draft');await save();$('#golf-save-pitch').classList.add('hidden');
};
$('#save-campaign-metrics').onclick=async()=>{
 const id=$('#metric-campaign').value,c=state.campaigns.find(x=>String(x.id)===String(id));
 if(!c)return alert('Select a campaign first.');
 const fields=['impressions','clicks','leads','conversions','spend','revenue'];
 const metric={id:Date.now(),date:$('#metric-date').value||new Date().toISOString().slice(0,10),notes:$('#metric-notes').value.trim()};
 for(const key of fields){const value=Number($('#metric-'+key).value||0);if(!Number.isFinite(value)||value<0)return alert('Enter non-negative numbers for campaign metrics.');metric[key]=value;}
 if(metric.clicks>metric.impressions&&metric.impressions>0)return alert('Clicks cannot exceed impressions in one reporting snapshot.');
 if(metric.leads>metric.clicks&&metric.clicks>0)return alert('Leads cannot exceed clicks in one reporting snapshot.');
 if(metric.conversions>metric.clicks&&metric.clicks>0)return alert('Conversions cannot exceed clicks in one reporting snapshot.');
 c.metrics=Array.isArray(c.metrics)?c.metrics:[];c.metrics.push(metric);addActivity('Recorded campaign performance for '+c.name);
 try{await save();['impressions','clicks','leads','conversions','spend','revenue','notes'].forEach(k=>$('#metric-'+k).value='');}catch(e){alert(e.message)}
};
$('#metric-campaign').addEventListener('change',()=>render());

$('#refresh-stripe-transactions').addEventListener('click',async()=>{
 const button=$('#refresh-stripe-transactions'),status=$('#stripe-transaction-status'),summary=$('#stripe-balance-summary'),list=$('#stripe-transaction-list');
 button.disabled=true;status.textContent='Loading read-only Stripe test data…';list.innerHTML='<div class="empty">Fetching payments, refunds, fees and payouts…</div>';
 try{
  const data=await api('/api/stripe/transactions');
  const totals=data.transactions.reduce((a,t)=>{if(['charge','payment'].includes(t.type)&&t.amount>0)a.gross+=t.amount;if(t.type==='refund')a.refunds+=Math.abs(t.amount);a.fees+=t.fee;a.net+=t.net;return a;},{gross:0,refunds:0,fees:0,net:0});
  const cards=[
   ['Available balance',(data.balance.available||[]).map(x=>money(x.amount)+' '+x.currency).join(' · ')||'—'],
   ['Pending balance',(data.balance.pending||[]).map(x=>money(x.amount)+' '+x.currency).join(' · ')||'—'],
   ['Gross charges',money(totals.gross)],['Refunds',money(totals.refunds)],
   ['Processing fees',money(totals.fees)],['Net balance activity',money(totals.net)]
  ];
  summary.innerHTML=cards.map(x=>'<div class="metric"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('');
  const rows=(data.transactions||[]).map(t=>{
   const date=new Date(t.created*1000).toLocaleString(),sign=t.amount<0?'−':'+';
   const detail=[t.description,t.customerEmail,t.sourceId].filter(Boolean).join(' · ');
   return '<div class="record"><div><strong>'+esc(t.type.replaceAll('_',' '))+' · '+esc(t.currency)+' '+esc(money(Math.abs(t.amount)))+'</strong><p>'+esc(detail||'Stripe balance transaction')+'</p><small>'+esc(date)+' · '+esc(t.status)+' · Fee '+esc(money(t.fee))+' · Net '+esc(money(t.net))+(t.refunded!==null?' · Refunded '+esc(money(t.refunded)):'')+'</small></div></div>';
  });
  const payoutRows=(data.payouts||[]).map(p=>'<div class="record"><div><strong>Payout · '+esc(p.currency)+' '+esc(money(p.amount))+'</strong><p>'+esc(p.id)+' · '+esc(p.method||'')+'</p><small>'+esc(p.status)+' · Created '+esc(new Date(p.created*1000).toLocaleString())+(p.arrivalDate?' · Expected '+esc(new Date(p.arrivalDate*1000).toLocaleDateString()):'')+'</small></div></div>');
  list.innerHTML='<p class="muted">Latest '+data.transactions.length+' balance transactions'+(data.hasMoreTransactions?' · More older transactions are available in Stripe':'')+'</p>'+(rows.join('')||'<div class="empty">No balance transactions found in this Stripe test account.</div>')+'<div class="panel-head subhead"><h3>Recent payouts</h3></div>'+(payoutRows.join('')||'<div class="empty">No payouts found.</div>');
  const rec=data.reconciliation||{},fmtTotals=totals=>Object.entries(totals||{}).map(([currency,amount])=>money(amount)+' '+currency).join(' · ')||'—';
  const recRows=[
   ['Paid app orders',String(rec.paidOrderCount||0)],
   ['Matched to Stripe',String(rec.matchedOrderCount||0)],
   ['Unmatched paid orders',String(rec.unmatchedPaidOrderCount||0)],
   ['Unmatched Stripe payments',String(rec.unmatchedStripePaymentCount||0)],
   ['Paid order totals',fmtTotals(rec.paidOrderTotals)],
   ['Completed payouts',String(rec.paidPayoutCount||0)+' · '+fmtTotals(rec.paidPayoutTotals)],
   ['Pending / in-transit payouts',String(rec.pendingPayoutCount||0)+' · '+fmtTotals(rec.pendingPayoutTotals)],
   ['Failed / canceled payouts',String(rec.failedPayoutCount||0)]
  ];
  const recBox=$('#stripe-reconciliation');
  if(recBox)recBox.innerHTML='<div class="form-grid">'+recRows.map(x=>'<div class="metric"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('')+'</div><p class="muted">'+esc(rec.note||'Payouts are transfers, not new revenue.')+'</p>'+(rec.unmatchedPaidOrders?.length?'<p><strong>Paid orders needing a match:</strong></p>'+rec.unmatchedPaidOrders.map(o=>'<p>'+esc(o.productName)+' · '+esc(money(o.amount)+' '+o.currency)+' · '+esc(o.id)+'</p>').join(''):'');
  list.dataset.loaded='true';status.textContent='Updated '+new Date(data.fetchedAt).toLocaleString()+' · Stripe test mode';
 }catch(error){status.textContent=error.message;list.innerHTML='<div class="empty">'+esc(error.message)+'</div>'}
 finally{button.disabled=false}
});
$('#run-optimization').addEventListener('click',async()=>{
 const button=$('#run-optimization'),out=$('#optimization-result');
 button.disabled=true;out.classList.remove('hidden');out.textContent='Analyzing actual ledger entries, campaign performance and saved opportunities…';
 try{
  const result=await api('/api/optimization/analyze',{method:'POST',body:JSON.stringify({})}),report=result.report;
  const clean = value => String(value ?? '').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&');
  const lines=[clean(report.summary),'','RECOMMENDATIONS',...report.recommendations.map((r,i)=>(i+1)+'. ['+clean(r.priority)+'] '+clean(r.action)+'\n   Why: '+clean(r.reason)+'\n   Measure: '+clean(r.metric)+'\n   Effort: '+clean(r.effort)+' · Confidence: '+clean(r.confidence)+(r.requiresApproval?' · Owner approval required':''))];
  if(report.dataGaps?.length)lines.push('','DATA GAPS',...report.dataGaps.map(x=>'• '+clean(x)));
  out.textContent=lines.join('\n');
  await loadState();
 }catch(error){out.textContent=error.message}
 finally{button.disabled=false;button.textContent='Analyze revenue and recommend next steps'}
});

$('#add-campaign').onclick=async()=>{const name=$('#campaign-name').value.trim();if(!name)return alert('Enter a campaign name.');state.campaigns.unshift({id:Date.now(),name,channel:$('#campaign-channel').value,goal:$('#campaign-goal').value,duration:$('#campaign-duration').value,plan:$('#campaign-plan').value,status:'Planned',created:new Date().toISOString()});addActivity('Created campaign plan: '+name);await save();$('#campaign-name').value='';$('#campaign-goal').value='';$('#campaign-plan').value=''};
$('#add-entry').onclick=async()=>{const amount=Number($('#entry-amount').value);if(!Number.isFinite(amount)||amount<=0)return alert('Enter an amount greater than zero.');state.revenue.push({id:Date.now(),type:$('#entry-type').value,amount,source:$('#entry-source').value||'Unspecified',date:$('#entry-date').value||new Date().toISOString().slice(0,10)});addActivity('Recorded '+$('#entry-type').value.toLowerCase()+' of '+money(amount));await save();$('#entry-amount').value='';$('#entry-source').value=''};
$('#save-settings').onclick=async()=>{state.settings={...state.settings,niche:$('#setting-niche').value,monthlyGoal:Number($('#setting-goal').value)||0,autonomy:$('#setting-autonomy').value,strategies:[...$$('.strategy:checked')].map(x=>x.value)};addActivity('Updated workspace settings');await save();alert('Settings saved.')};
async function start(){if(!token){showLogin();return}try{showApp();await loadState()}catch{showLogin()}}start();

$('#commerce-create').onclick=async()=>{
 const name=$('#commerce-name').value.trim(),amount=Number($('#commerce-price').value),type=$('#commerce-type').value,billing=$('#commerce-billing').value,deliveryContent=$('#commerce-delivery-content').value.trim();
 if(!name||!Number.isFinite(amount)||amount<=0)return alert('Enter a product name and a valid price.');
 if(type==='physical'&&billing==='subscription')return alert('Recurring physical-product orders are not enabled. Choose one-time purchase.');if(type==='digital'&&!deliveryContent)return alert('Add the digital content customers will receive after payment.');
 const button=$('#commerce-create'),out=$('#commerce-result');button.disabled=true;out.classList.remove('hidden');out.textContent='Saving product…';
 try{const r=await api('/api/commerce/products',{method:'POST',body:JSON.stringify({name,description:$('#commerce-description').value,deliveryContent,type,billing,amount,interval:$('#commerce-interval').value})});state.products=state.products||[];state.products.unshift(r.product);addActivity('Created product: '+name);await save();out.textContent='Product saved. Create a test checkout when Stripe test credentials are configured.';$('#commerce-name').value='';$('#commerce-description').value='';$('#commerce-delivery-content').value='';$('#commerce-price').value='';}
 catch(e){out.textContent=e.message}finally{button.disabled=false}
};
$('#commerce-orders').addEventListener('click',async e=>{
 const retry=e.target.closest('[data-action^="commerce-email-retry:"]');
 if(retry){const orderId=retry.dataset.action.slice('commerce-email-retry:'.length);retry.disabled=true;retry.textContent='Sending…';try{const r=await api('/api/commerce/orders/'+encodeURIComponent(orderId)+'/resend-email',{method:'POST'});const i=state.orders.findIndex(x=>x.id===orderId||x.checkoutSessionId===orderId);if(i>=0)state.orders[i]=r.order;addActivity('Digital delivery email sent for '+(r.order.productName||'order'));render();}catch(err){alert(err.message);retry.disabled=false;retry.textContent='Retry delivery email';}return;}
 const button=e.target.closest('[data-action^="commerce-fulfill:"]');if(!button)return;
 const orderId=button.dataset.action.slice('commerce-fulfill:'.length);button.disabled=true;
 try{const r=await api('/api/commerce/orders/'+encodeURIComponent(orderId)+'/fulfill',{method:'POST'});state.orders=state.orders||[];const i=state.orders.findIndex(x=>x.id===orderId||x.checkoutSessionId===orderId);if(i>=0)state.orders[i]=r.order;addActivity('Marked Stripe order fulfilled');await save();}
 catch(err){alert(err.message);button.disabled=false}
});
$('#commerce-list').addEventListener('click',async e=>{
 const button=e.target.closest('[data-action^="commerce-checkout:"]');if(!button)return;
 const productId=button.dataset.action.split(':')[1],email=$('#commerce-email').value.trim();
 button.disabled=true;const out=$('#commerce-result');out.classList.remove('hidden');out.textContent='Creating Stripe test checkout…';
 try{const r=await api('/api/commerce/checkout',{method:'POST',body:JSON.stringify({productId,email})});out.textContent='Stripe test checkout is ready. Opening secure checkout…';window.location.href=r.url;}
 catch(err){out.textContent=err.message;button.disabled=false}
});


$('#export-backup').addEventListener('click', async () => {
 const button = $('#export-backup'), status = $('#backup-result');
 button.disabled = true; status.textContent = 'Preparing secure workspace backup…';
 try {
  const response = await fetch('/api/state/export', { headers: { Authorization: 'Bearer ' + token } });
  if (response.status === 401) { logoutLocal(); throw new Error('Session expired. Sign in again.'); }
  if (!response.ok) {
   const problem = await response.json().catch(() => ({}));
   throw new Error(problem.error || 'Backup download failed.');
  }
  const blob = await response.blob(), url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'autorevenue-ai-backup-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  status.textContent = 'Backup downloaded. Store it somewhere private; it contains your workspace records.';
 } catch (error) { status.textContent = error.message; }
 finally { button.disabled = false; }
});

document.addEventListener('click',async e=>{
 const button=e.target.closest('[data-copy-download]');
 if(!button)return;
 const url=button.getAttribute('data-copy-download');
 try{await navigator.clipboard.writeText(url);button.textContent='Copied';}
 catch{window.prompt('Copy this download link:',url);}
});
