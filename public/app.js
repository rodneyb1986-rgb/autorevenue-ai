const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const KEY='autorevenue_session';let token=sessionStorage.getItem(KEY)||'',state={opportunities:[],campaigns:[],content:[],revenue:[],approvals:[],activity:[],settings:{niche:'',monthlyGoal:500,autonomy:'approval',strategies:['affiliate','digital-products','lead-generation','content']}},generatedAsset='',generatedGolfPitch='',aiPricingConfigured=false;
function money(n){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(n)||0)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function headers(){return {'Content-Type':'application/json','Authorization':'Bearer '+token}}
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{...headers(),...(opts.headers||{})}}),j=await r.json().catch(()=>({}));if(r.status===401){logoutLocal();throw Error('Session expired. Sign in again.')}if(!r.ok)throw Error(j.error||'Request failed');return j}
function showLogin(){$('#login-screen').classList.remove('hidden');$('#app').classList.add('hidden')}
function showApp(){$('#login-screen').classList.add('hidden');$('#app').classList.remove('hidden')}
function logoutLocal(){token='';sessionStorage.removeItem(KEY);showLogin()}
async function loadState(){state=await api('/api/state');state.settings=state.settings||{};state.suppliers=state.suppliers||[];render();await checkSystem();await verifyCheckoutReturn()}
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
$('#login-form').addEventListener('submit',async e=>{e.preventDefault();const form=$('#login-form'),button=form.querySelector('button[type="submit"]'),password=$('#login-password').value,error=$('#login-error');if(!password){error.textContent='Enter your admin password.';return;}button.disabled=true;button.textContent='Signing in…';error.textContent='';let phase='contacting sign-in service';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}),j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'Sign-in failed. Please try again.');if(!j.token)throw Error('The server did not return a sign-in session.');token=j.token;sessionStorage.setItem(KEY,token);phase='loading workspace';state=await api('/api/state');state.settings=state.settings||{};state.suppliers=state.suppliers||[];$('#login-password').value='';showApp();try{render();await checkSystem();await verifyCheckoutReturn();}catch(uiError){console.error('Dashboard initialization failed:',uiError);const status=$('#system-state');if(status)status.textContent='Signed in; dashboard needs a refresh. '+(uiError.message||'UI error');} }catch(err){token='';sessionStorage.removeItem(KEY);showLogin();error.textContent=phase+': '+(err.message||'Sign-in failed. Please try again.');}finally{button.disabled=false;button.textContent='Sign in';}});
async function save(){await api('/api/state',{method:'PUT',body:JSON.stringify(state)});render()}
async function checkSystem(){try{const h=await fetch('/api/health').then(r=>r.json());aiPricingConfigured=Boolean(h.aiCostRatesConfigured);$('#system-state').textContent=h.aiConfigured?'AI configured':'AI setup required';$('#system-state').className='status '+(h.aiConfigured?'ok':'warn');const items=[['Admin password',h.authConfigured],['OpenAI connection',h.aiConfigured],['PostgreSQL storage',h.storageReady&&h.persistentStorage],['Stripe test key',h.stripeTestConfigured],['Stripe webhook',h.stripeWebhookConfigured],['Automatic delivery email',h.emailDeliveryConfigured]];$('#config-status').innerHTML=items.map(x=>'<div class="config"><strong>'+esc(x[0])+'</strong><small class="'+(x[1]?'ok':'warn')+'">'+(x[1]?'Configured':'Needs setup')+'</small></div>').join('')}catch{$('#system-state').textContent='Server check failed'}}
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
function view(name){$$('.view').forEach(x=>x.classList.add('hidden'));$('#view-'+name).classList.remove('hidden');$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===name));const names={dashboard:'Command Center',leads:'Buyer Leads',suppliers:'Supplier Partners',opportunities:'Opportunity Finder',content:'Content Studio',campaigns:'Campaign Planner',revenue:'Revenue & Profit',approvals:'Approval Queue',golf:'Golf Gear Opportunities',commerce:'Products & Checkout',settings:'Settings'};$('#page-title').textContent=names[name]||'Command Center'}
$$('.nav').forEach(b=>b.addEventListener('click',()=>view(b.dataset.view)));$$('[data-go]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.go)));$('#new-content').onclick=()=>view('content');
$('#refresh-leads').addEventListener('click',async()=>{try{const r=await api('/api/leads');state.leads=r.leads;render()}catch(e){alert(e.message)}});
$('#export-leads').addEventListener('click',()=>{
 const rows=state.leads||[];if(!rows.length)return alert('There are no leads to export yet.');
 const cols=['createdAt','name','email','phone','zip','equipment','model','attachment','timeline','details','score','status','source','utmSource','utmMedium','utmCampaign'];
 const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
 const csv=[cols.join(','),...rows.map(row=>cols.map(k=>quote(row[k])).join(','))].join('\\r\\n');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='autorevenue-buyer-leads-'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
});

$('#lead-list').addEventListener('change',async e=>{const select=e.target.closest('[data-lead-status]');if(!select)return;select.disabled=true;try{const r=await api('/api/leads/'+encodeURIComponent(select.dataset.leadStatus),{method:'PATCH',body:JSON.stringify({status:select.value})});const i=state.leads.findIndex(x=>x.id===r.lead.id);if(i>=0)state.leads[i]=r.lead;render()}catch(err){alert(err.message)}finally{select.disabled=false}});
$('#lead-list').addEventListener('click',async e=>{const b=e.target.closest('[data-lead-action]');if(!b)return;const id=b.dataset.leadId,action=b.dataset.leadAction;try{let payload={};if(action==='approve-share'){if(!confirm('Confirm that this buyer gave consent to share their request with a matched supplier?'))return;payload.sharingApproved=true;}if(action==='record-fee'){const amount=Number(prompt('Enter referral fee actually received (USD):'));if(!Number.isFinite(amount)||amount<=0)return;payload.referralFeeReceived=amount;}const r=await api('/api/leads/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(payload)});const i=state.leads.findIndex(x=>x.id===id);if(i>=0)state.leads[i]=r.lead;render()}catch(err){alert(err.message)}});
$('#lead-list').addEventListener('change',async e=>{const el=e.target.closest('[data-lead-supplier],[data-lead-followup],[data-lead-referral],[data-lead-note]');if(!el)return;const id=el.dataset.leadId;let payload={};if(el.hasAttribute('data-lead-supplier'))payload.matchedSupplierId=el.value;if(el.hasAttribute('data-lead-followup'))payload.followUpAt=el.value;if(el.hasAttribute('data-lead-referral'))payload.referralStatus=el.value;if(el.hasAttribute('data-lead-note'))payload.followUpNote=el.value;try{const r=await api('/api/leads/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(payload)});const i=state.leads.findIndex(x=>x.id===id);if(i>=0)state.leads[i]=r.lead;render()}catch(err){alert(err.message);render()}});
$('#supplier-add').addEventListener('click',async()=>{const name=$('#supplier-name').value.trim();if(!name)return alert('Enter a supplier name.');const payload={name,contactName:$('#supplier-contact').value,email:$('#supplier-email').value,phone:$('#supplier-phone').value,website:$('#supplier-website').value,zipCodes:$('#supplier-zips').value,equipment:$('#supplier-equipment').value,attachments:$('#supplier-attachments').value,feeModel:$('#supplier-fee-model').value,feeAmount:$('#supplier-fee-amount').value};try{const r=await api('/api/suppliers',{method:'POST',body:JSON.stringify(payload)});state.suppliers.unshift(r.supplier);['supplier-name','supplier-contact','supplier-email','supplier-phone','supplier-website','supplier-zips','supplier-equipment','supplier-attachments','supplier-fee-amount'].forEach(id=>$('#'+id).value='');render()}catch(err){alert(err.message)}});
$('#supplier-list').addEventListener('change',async e=>{const el=e.target.closest('[data-supplier-status],[data-supplier-agreement]');if(!el)return;const id=el.dataset.supplierId,payload=el.hasAttribute('data-supplier-status')?{status:el.value}:{agreementStatus:el.value};try{const r=await api('/api/suppliers/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(payload)});const i=state.suppliers.findIndex(x=>x.id===id);if(i>=0)state.suppliers[i]=r.supplier;render()}catch(err){alert(err.message)}});

function addActivity(message){state.activity.unshift({message,at:new Date().toISOString()});state.activity=state.activity.slice(0,40)}
function record(title,body,status,actions){let buttons=actions.map(a=>'<button class="mini" data-action="'+a[1]+'">'+esc(a[0])+'</button>').join('');return '<div class="record"><div><strong>'+esc(title)+'</strong><p>'+esc(body||'')+'</p><small>'+esc(status||'')+'</small></div><div class="record-actions">'+buttons+'</div></div>'}
function renderDashboardCharts(){
 const revenue=Array.isArray(state.revenue)?state.revenue:[];
 const now=new Date(),months=[];
 for(let offset=5;offset>=0;offset--){
  const d=new Date(now.getFullYear(),now.getMonth()-offset,1);
  const key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  months.push({key,label:d.toLocaleDateString('en-US',{month:'short'}),income:0,expense:0});
 }
 for(const entry of revenue){
  const key=String(entry.date||'').slice(0,7),bucket=months.find(m=>m.key===key);
  if(!bucket)continue;
  const amount=Math.max(0,Number(entry.amount)||0);
  if(entry.type==='Income')bucket.income+=amount;
  else if(entry.type==='Expense')bucket.expense+=amount;
 }
 const chart=$('#revenue-chart');
 if(!chart)return;
 const max=Math.max(1,...months.flatMap(m=>[m.income,m.expense]));
 const W=620,H=220,left=48,right=12,top=16,bottom=36,plotH=H-top-bottom;
 const groupW=(W-left-right)/months.length,barW=Math.min(24,groupW*.26);
 const grid=[0,.5,1].map(t=>{
  const y=top+plotH*(1-t),label=max*t>=1000?'$'+(max*t/1000).toFixed(1)+'k':money(max*t);
  return '<line x1="'+left+'" y1="'+y+'" x2="'+(W-right)+'" y2="'+y+'" stroke="#2a3d56" stroke-dasharray="3 5"/><text x="'+(left-8)+'" y="'+(y+4)+'" fill="#8fa3be" font-size="10" text-anchor="end">'+label+'</text>';
 }).join('');
 const bars=months.map((m,i)=>{
  const center=left+groupW*(i+.5),incomeH=m.income/max*plotH,expenseH=m.expense/max*plotH;
  return '<rect x="'+(center-barW-2)+'" y="'+(top+plotH-incomeH)+'" width="'+barW+'" height="'+Math.max(0,incomeH)+'" rx="3" fill="#55c7e8"/><rect x="'+(center+2)+'" y="'+(top+plotH-expenseH)+'" width="'+barW+'" height="'+Math.max(0,expenseH)+'" rx="3" fill="#a78bfa"/><text x="'+center+'" y="'+(H-10)+'" fill="#8fa3be" font-size="11" text-anchor="middle">'+m.label+'</text>';
 }).join('');
 chart.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Monthly income and expenses">'+grid+bars+'</svg>';
}
function render(){
 const income=state.revenue.filter(x=>x.type==='Income').reduce((a,x)=>a+Number(x.amount),0),expense=state.revenue.filter(x=>x.type==='Expense').reduce((a,x)=>a+Number(x.amount),0);
 $('#m-net').textContent=money(income-expense);$('#m-content').textContent=state.content.length;$('#m-ideas').textContent=state.opportunities.length;$('#m-approvals').textContent=state.approvals.filter(x=>x.status==='Pending').length;const digitalOrders=(state.orders||[]).filter(x=>x.paymentStatus==='paid'&&x.deliveryToken);const emailSent=digitalOrders.filter(x=>x.deliveryEmailStatus==='sent').length;const emailNeedsAttention=digitalOrders.length-emailSent;$('#m-email').textContent=emailSent+' / '+digitalOrders.length;$('#m-email-note').textContent=digitalOrders.length?emailNeedsAttention+' need attention':'No paid digital orders yet';
 const leads=state.leads||[];$('#lead-total').textContent=leads.length;$('#lead-qualified').textContent=leads.filter(x=>['Qualified','Contacted','Converted'].includes(x.status)).length;$('#lead-converted').textContent=leads.filter(x=>x.status==='Converted').length;$('#lead-list').innerHTML=leads.map(x=>{const rankedSuppliers=(state.suppliers||[]).filter(s=>s.status==='Active').map(s=>{const zipMatch=(s.zipCodes||[]).includes(String(x.zip||'')),terms=(String(s.equipment||'')+' '+String(s.attachments||'')).toLowerCase(),leadTerms=(String(x.equipment||'')+' '+String(x.attachment||'')).toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>3),categoryMatch=leadTerms.some(t=>terms.includes(t));return {...s,matchScore:(zipMatch?2:0)+(categoryMatch?1:0)}}).sort((a,b)=>b.matchScore-a.matchScore);const supplierOptions='<option value="">No supplier matched</option>'+rankedSuppliers.map(s=>'<option value="'+esc(s.id)+'"'+(x.matchedSupplierId===s.id?' selected':'')+'>'+esc(s.name)+(s.matchScore?' · Suggested':'')+'</option>').join('');return '<div class="record"><div><strong>'+esc(x.name)+' · '+esc(x.attachment)+'</strong><p>'+esc(x.email)+' · '+esc(x.phone||'No phone')+' · ZIP '+esc(x.zip)+'<br>'+esc(x.equipment||'Equipment not specified')+' '+esc(x.model||'')+' · '+esc(x.timeline)+'<br>'+esc(x.details||'No additional details')+'<br>Source: '+esc(x.source||'Direct')+(x.utmCampaign?' · Campaign: '+esc(x.utmCampaign):'')+'</p><small>Score '+Number(x.score||0)+'/100 · '+esc(x.status)+' · Referral: '+esc(x.referralStatus||'Unmatched')+' · '+esc(new Date(x.createdAt).toLocaleString())+'</small><div class="lead-tools"><label>Supplier<select data-lead-id="'+esc(x.id)+'" data-lead-supplier>'+supplierOptions+'</select></label><label>Follow-up date<input type="date" data-lead-id="'+esc(x.id)+'" data-lead-followup value="'+esc(x.followUpAt||'')+'"></label><label>Referral stage<select data-lead-id="'+esc(x.id)+'" data-lead-referral>'+['Unmatched','Candidate','Approved to Share','Sent','Accepted','Rejected','Converted','Fee Received'].map(v=>'<option'+((x.referralStatus||'Unmatched')===v?' selected':'')+'>'+v+'</option>').join('')+'</select></label></div><small>'+(x.sharingApprovedAt?'Buyer sharing approval recorded':'Buyer sharing requires your review')+'</small></div><div class="record-actions"><a class="mini" href="mailto:'+encodeURIComponent(x.email)+'?subject='+encodeURIComponent('Your equipment request')+'">Email</a><select data-lead-status="'+esc(x.id)+'">'+['New','Qualified','Contacted','Converted','Closed'].map(v=>'<option'+(x.status===v?' selected':'')+'>'+v+'</option>').join('')+'</select><button class="mini" data-lead-action="approve-share" data-lead-id="'+esc(x.id)+'">Approve sharing</button>'+(x.referralStatus==='Converted'?'<button class="mini" data-lead-action="record-fee" data-lead-id="'+esc(x.id)+'">Record fee received</button>':'')+'</div></div>'}).join('')||'<div class="empty">No buyer requests yet. Share the public lead page to start collecting consent-based inquiries.</div>';
 $('#supplier-list').innerHTML=(state.suppliers||[]).map(x=>'<div class="record supplier-row"><div><strong>'+esc(x.name)+'</strong><p>'+esc(x.equipment||'Equipment unspecified')+' · '+esc(x.attachments||'Attachments unspecified')+' · ZIPs '+esc((x.zipCodes||[]).join(', ')||x.regions||'Not set')+'<br>Referral: '+esc(x.feeModel)+' '+esc(x.feeAmount||'')+' · Agreement: '+esc(x.agreementStatus)+'</p></div><div class="record-actions"><select data-supplier-id="'+esc(x.id)+'" data-supplier-agreement><option'+(x.agreementStatus==='Pending'?' selected':'')+'>Pending</option><option'+(x.agreementStatus==='Agreed'?' selected':'')+'>Agreed</option></select><select data-supplier-id="'+esc(x.id)+'" data-supplier-status><option'+(x.status==='Active'?' selected':'')+'>Active</option><option'+(x.status==='Inactive'?' selected':'')+'>Inactive</option></select></div></div>').join('')||'<div class="empty">No supplier partners entered yet.</div>';
 $('#supplier-directory').innerHTML=(state.suppliers||[]).map(x=>'<div class="record supplier-row"><div><strong>'+esc(x.name)+'</strong><p>'+esc(x.equipment||'Equipment unspecified')+' · '+esc(x.attachments||'Attachments unspecified')+' · '+esc(x.status)+' · Agreement '+esc(x.agreementStatus)+'</p></div></div>').join('')||'<div class="empty">No supplier partners entered yet.</div>';
 const due=leads.filter(x=>x.followUpAt&&x.followUpAt<=new Date().toISOString().slice(0,10)&&!['Closed','Converted'].includes(x.status));$('#followup-list').innerHTML=due.map(x=>'<div class="record followup-due"><div><strong>'+esc(x.name)+' · '+esc(x.attachment)+'</strong><p>Due '+esc(x.followUpAt)+' · '+esc(x.email)+' · '+esc(x.zip)+'</p></div></div>').join('')||'<div class="empty">No follow-ups due today.</div>';$('#activity').innerHTML=state.activity.length?state.activity.slice(0,8).map(x=>'<div class="activity-item">'+esc(x.message)+'<small>'+esc(new Date(x.at).toLocaleString())+'</small></div>').join(''):'<div class="empty">Your activity will appear here.</div>';
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
 const golfRows=state.golfOpportunities||[];const golfDue=golfRows.filter(x=>x.nextFollowUp&&x.nextFollowUp<=new Date().toISOString().slice(0,10)&&!['Declined','Received'].includes(x.status));$('#golf-list').innerHTML='<p class="muted">Pipeline: '+golfRows.length+' total · '+golfRows.filter(x=>['Eligible','Application drafted','Applied (manual)','Follow-up'].includes(x.status)).length+' active · '+golfRows.filter(x=>x.status==='Received').length+' received · '+golfDue.length+' follow-ups due. Benefits are not counted as earnings until received.</p>'+golfRows.map((x,i)=>record(x.brand+' · '+x.type,x.equipment+'\\nBenefit: '+(x.benefit||'Not confirmed')+'\\nDeadline: '+(x.deadline||'Not specified')+' · Follow-up: '+(x.nextFollowUp||'Not set')+'\\n'+(x.notes||'')+'\\nProgram: '+(x.url||'')+'\\nSource: '+(x.sourceUrl||'Not recorded')+'\\n'+(x.verificationStatus||'Terms not verified'),'<select class="golf-status" data-golf-status="'+esc(x.id)+'">'+['To research','Eligible','Application drafted','Applied (manual)','Follow-up','Accepted','Declined','Received'].map(v=>'<option'+((x.status||'To research')===v?' selected':'')+'>'+v+'</option>').join('')+'</select>',[['Delete','golf-delete:'+i]])).join('')||'<div class="empty">No golf gear opportunities saved yet.</div>';
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
 const usageBox=$('#ai-usage-summary');if(usageBox)usageBox.textContent='Today: '+todayRows.length+' requests · '+tokens(todayRows).toLocaleString()+' tokens | This month: '+monthRows.length+' requests · '+tokens(monthRows).toLocaleString()+' tokens.';const costBox=$('#ai-cost-summary');if(costBox){const cost=rows=>rows.reduce((n,x)=>n+Number(x.estimatedCostUsd||0),0);costBox.textContent=aiPricingConfigured?'Estimated API cost · today: '+money(cost(todayRows))+' · this month: '+money(cost(monthRows))+'. Based on the per-million-token rates configured in Render.':'API cost estimates are not enabled yet. Configure OPENAI_INPUT_USD_PER_1M and OPENAI_OUTPUT_USD_PER_1M in Render using the rates for your selected model.';}
 $('#setting-niche').value=state.settings.niche||'';$('#setting-goal').value=state.settings.monthlyGoal??500;$('#setting-autonomy').value=state.settings.autonomy||'approval';$$('.strategy').forEach(c=>c.checked=(state.settings.strategies||[]).includes(c.value));
 $$('[data-action]').forEach(b=>b.onclick=()=>handleAction(b.dataset.action));
}
async function handleAction(action){const parts=action.split(':'),kind=parts[0],i=Number(parts[1]);if(kind==='campaign-from-idea'){const idea=state.opportunities.find(x=>String(x.id)===String(parts[1]));if(idea){state.campaigns.unshift({id:Date.now(),name:'Validation: '+idea.title,channel:'Website / blog',goal:'Validate demand for '+idea.offer,duration:(idea.validationDays||14)+' days',plan:'Target customer: '+(idea.customer||'To define')+'\\nProblem: '+(idea.problem||'')+'\\nOffer: '+(idea.offer||'')+'\\nMonetization hypothesis: '+(idea.monetization||'')+'\\nValidation steps: '+(idea.validationSteps||[]).join(' | ')+'\\nMain risk: '+(idea.mainRisk||'')+'\\nAI score: '+(idea.score??'N/A')+'/100; hypothesis only.',status:'Draft · validation required',sourceOpportunityId:idea.id,created:new Date().toISOString()});view('campaigns');}} if(kind==='content-from-campaign'){const campaign=state.campaigns.find(x=>String(x.id)===String(parts[1]));if(campaign){const brief='CAMPAIGN: '+campaign.name+'\\nCHANNEL: '+(campaign.channel||'To decide')+'\\nGOAL: '+(campaign.goal||'')+'\\nAUDIENCE / OFFER / PLAN:\\n'+(campaign.plan||'')+'\\n\\nCreate useful, truthful content that supports this campaign goal. Include a clear call to action, but do not invent product claims, customer results, pricing, or guarantees. Treat this as a draft for human review.';state.content.unshift({id:Date.now(),title:'Content brief: '+campaign.name,type:'Campaign content brief',body:brief,status:'Draft',campaignId:campaign.id,created:new Date().toISOString()});addActivity('Created content brief for '+campaign.name);view('content');}} if(kind==='delete-idea')state.opportunities.splice(i,1);if(kind==='delete-content')state.content.splice(i,1);if(kind==='delete-campaign')state.campaigns.splice(i,1);if(kind==='approve-content'){const x=state.content[i];state.approvals.unshift({id:Date.now(),title:'Content: '+x.title,details:x.body,status:'Pending',created:new Date().toISOString()})}if(kind==='approve-campaign'){const x=state.campaigns[i];state.approvals.unshift({id:Date.now(),title:'Campaign: '+x.name,details:x.plan,status:'Pending',created:new Date().toISOString()})}if(kind==='approve'||kind==='reject'){state.approvals[i].status=kind==='approve'?'Approved':'Rejected';state.approvals[i].decidedAt=new Date().toISOString()}if(kind==='golf-delete'){state.golfOpportunities.splice(i,1)}if(kind==='golf-applied'){state.golfOpportunities[i].status='Application prepared / submitted manually';state.golfOpportunities[i].updatedAt=new Date().toISOString()}addActivity(kind.replaceAll('-',' ')+' updated');try{await save()}catch(e){alert(e.message)}}

$('#run-automation').addEventListener('click',runAutomation);
$('#run-full-cycle').addEventListener('click',async()=>{
 const button=$('#run-full-cycle'),out=$('#automation-result');
 button.disabled=true;out.classList.remove('hidden');out.textContent='Reviewing saved records across all modules…';
 try{
  const result=await api('/api/automation/run-cycle',{method:'POST',body:JSON.stringify({})});
  const counts=result.snapshot&&result.snapshot.counts||{};
  out.textContent='Full-app review completed. '+Number(counts.tasks||0)+' internal action items created. No external messages, paid actions, customer-data sharing or publishing occurred.';
  const modules=result.snapshot&&result.snapshot.modules||{};
  $('#automation-modules').innerHTML=Object.keys(modules).map(key=>'<div class="record"><div><strong>'+esc(key)+'</strong><p>'+esc(modules[key].detail||'')+'</p><small>'+esc(modules[key].status||'ready')+'</small></div></div>').join('');
  const tasks=result.snapshot&&result.snapshot.tasks||[];
  $('#automation-tasks').innerHTML='<div class="panel-head subhead"><h3>Action queue · '+tasks.length+'</h3></div>'+tasks.map(task=>'<div class="record"><div><strong>'+esc(task.title)+'</strong><p>'+esc(task.detail)+'</p></div></div>').join('');
  await loadState();
 }catch(error){out.textContent=error.message;}
 finally{button.disabled=false;}
});
$('#refresh-automation').addEventListener('click',async()=>{
 const button=$('#refresh-automation'),out=$('#automation-result');button.disabled=true;
 try{const result=await api('/api/automation/status');const modules=result.modules||{};$('#automation-modules').innerHTML=Object.keys(modules).map(key=>'<div class="record"><div><strong>'+esc(key)+'</strong><p>'+esc(modules[key].detail||'')+'</p><small>'+esc(modules[key].status||'ready')+'</small></div></div>').join('');out.classList.remove('hidden');out.textContent=result.lastRun?'Last full-app review: '+new Date(result.lastRun.created).toLocaleString():'No full-app review recorded yet.';}
 catch(error){out.classList.remove('hidden');out.textContent=error.message;}
 finally{button.disabled=false;}
});

$('#logout').addEventListener('click',async()=>{try{if(token)await api('/api/logout',{method:'POST'})}catch{}finally{logoutLocal()}});

async function runAutomation(){
 const button=$('#run-automation'), output=$('#automation-result');
 button.disabled=true;button.textContent='Generating plan…';output.classList.remove('hidden');output.textContent='AI is preparing an opportunity, campaign and content draft…';
 try{
  const r=await api('/api/automation/run',{method:'POST',body:JSON.stringify({niche:state.settings.niche,strategies:state.settings.strategies})});
  output.textContent='Created: '+r.created.opportunity+' · '+r.created.campaign+' · '+r.created.content+'\\nNo external actions were taken. Drafts are saved for the next step: '+r.nextStep;
  await loadState();
 }catch(e){output.textContent=e.message}
 finally{button.disabled=false;button.textContent='Generate growth plan'}
}

async function generate(type,prompt,niche,target){target.classList.remove('hidden');target.textContent='Working…';try{const r=await api('/api/generate',{method:'POST',body:JSON.stringify({type,prompt,niche})});target.textContent=r.result;return r.result}catch(e){target.textContent=e.message;return ''}}
$('#idea-result').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)handleAction(b.dataset.action)});
$('#generate-ideas').onclick=async()=>{
 const niche=$('#idea-niche').value||state.settings.niche,strategy=$('#idea-strategy').value,focus=$('#idea-prompt').value,target=$('#idea-result');
 target.classList.remove('hidden');target.textContent='Analyzing opportunities and scoring validation potential…';
 const button=$('#generate-ideas');button.disabled=true;
 try{
  const r=await api('/api/opportunities/analyze',{method:'POST',body:JSON.stringify({niche,strategy,focus})});
  target.innerHTML='<p class="muted">'+esc(r.scoring)+'</p>'+r.opportunities.map((o,i)=>'<article class="record"><div><div class="panel-head"><strong>#'+(i+1)+' · '+esc(o.title)+'</strong><span class="tag">Score '+o.score+'/100</span></div><p><b>Customer:</b> '+esc(o.customer)+'</p><p><b>Problem:</b> '+esc(o.problem)+'</p><p><b>Offer:</b> '+esc(o.offer)+'</p><p><b>Monetization:</b> '+esc(o.monetization)+'</p><p><b>Estimated startup cost:</b> '+money(o.startupCostLow)+'–'+money(o.startupCostHigh)+' · <b>Validation:</b> '+o.validationDays+' days</p><p><b>Time to first sale (planning range):</b> '+(o.timeToFirstSaleDaysLow||14)+'–'+(o.timeToFirstSaleDaysHigh||45)+' days</p><p><b>Confidence:</b> '+esc(o.confidence||'low')+' · '+esc(o.confidenceReason||'Validate before investing.')+'</p><p><b>Score breakdown (1–5):</b> Pain '+(o.scores?.pain||'—')+' · Customer clarity '+(o.scores?.customerClarity||'—')+' · Margin potential '+(o.scores?.marginPotential||'—')+' · Execution ease '+(o.scores?.executionEase||'—')+' · Validation ease '+(o.scores?.validationEase||'—')+' · Competition risk '+(o.scores?.competitionRisk||'—')+'</p><p><b>Unit economics to verify:</b></p><ul>'+(o.unitEconomicsToVerify||[]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p><b>Assumptions:</b></p><ul>'+(o.assumptions||[]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p><b>Main risk:</b> '+esc(o.mainRisk)+'</p><p><b>Validation steps:</b></p><ol>'+o.validationSteps.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ol><small>'+esc(o.scoreBasis)+' · No sales or profit forecast until actual unit economics are entered.</small><div class="button-row"><button class="btn secondary" data-action="campaign-from-idea:'+esc(o.id)+'">Build validation campaign</button></div></div></article>').join('');
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
 state.golfOpportunities.unshift({id:Date.now(),brand,type:$('#golf-type').value,equipment,url:$('#golf-url').value.trim(),sourceUrl:$('#golf-source').value.trim(),benefit:$('#golf-benefit').value.trim(),deadline:$('#golf-deadline').value||'',nextFollowUp:$('#golf-followup').value||'',notes:$('#golf-notes').value.trim(),verificationStatus:'Unverified — confirm on official program page',status:'To research',created:new Date().toISOString()});
 addActivity('Saved golf gear opportunity: '+brand);await save();['golf-brand','golf-equipment','golf-url','golf-source','golf-benefit','golf-deadline','golf-followup','golf-notes'].forEach(id=>$('#'+id).value='');
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
