import express from 'express';
import helmet from 'helmet';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'1mb'}));
app.use(express.static(path.join(process.cwd(),'public')));

const seed = {
  opportunities:[
    {id:'opp-1',title:'DIY & home improvement',category:'Content niche',score:87,trend:'Rising',monetization:'Affiliate products + guides',description:'Practical tools, repairs, and projects with purchase intent.'},
    {id:'opp-2',title:'Outdoor equipment',category:'Product niche',score:82,trend:'Rising',monetization:'Product affiliates',description:'Equipment comparisons, seasonal tips, and buying guides.'},
    {id:'opp-3',title:'AI productivity',category:'Content niche',score:78,trend:'Stable',monetization:'Software affiliates + templates',description:'Useful AI workflows and demonstrations for everyday users.'}
  ],
  campaigns:[],
  posts:[],
  metrics:{views:0,clicks:0,conversions:0,revenue:0},
  settings:{brandName:'AutoRevenue AI',primaryPlatform:'Facebook',contentTone:'Helpful, practical, authentic',approvalRequired:true}
};
async function readDB(){
  try{return JSON.parse(await fs.readFile(DB_FILE,'utf8'));}
  catch {await writeDB(seed);return structuredClone(seed);}
}
async function writeDB(db){await fs.mkdir(DATA_DIR,{recursive:true});await fs.writeFile(DB_FILE,JSON.stringify(db,null,2));}
const id=()=>crypto.randomUUID();
app.get('/api/health',(_,res)=>res.json({ok:true,app:'AutoRevenue AI',version:'1.0.0',aiConfigured:!!client}));
app.get('/api/dashboard',async(_,res)=>{
 const db=await readDB();
 const approved=db.posts.filter(p=>p.status==='approved').length;
 const pending=db.posts.filter(p=>p.status==='pending').length;
 res.json({metrics:db.metrics,counts:{campaigns:db.campaigns.length,posts:db.posts.length,pending,approved},recentPosts:db.posts.slice(-6).reverse(),opportunities:db.opportunities.slice(0,3)});
});
app.get('/api/opportunities',async(_,res)=>res.json((await readDB()).opportunities));
app.post('/api/opportunities',async(req,res)=>{
 const db=await readDB();const item={id:id(),title:req.body.title||'New opportunity',category:req.body.category||'Idea',score:Number(req.body.score)||50,trend:'Unreviewed',monetization:req.body.monetization||'To be researched',description:req.body.description||''};
 db.opportunities.unshift(item);await writeDB(db);res.status(201).json(item);
});
app.get('/api/campaigns',async(_,res)=>res.json((await readDB()).campaigns));
app.post('/api/campaigns',async(req,res)=>{
 const db=await readDB();const campaign={id:id(),name:req.body.name||'Untitled campaign',goal:req.body.goal||'Engagement',platform:req.body.platform||'Facebook',status:'Draft',createdAt:new Date().toISOString(),description:req.body.description||''};db.campaigns.unshift(campaign);await writeDB(db);res.status(201).json(campaign);
});
app.get('/api/posts',async(_,res)=>res.json((await readDB()).posts));
app.post('/api/generate',async(req,res)=>{
 const {topic='',platform='Facebook',goal='Engagement',tone='Helpful, practical, authentic',format='Post'}=req.body;
 if(!topic.trim())return res.status(400).json({error:'Enter a topic first.'});
 let content;
 if(client){
  try{
   const response=await client.chat.completions.create({model:process.env.OPENAI_MODEL||'gpt-6',messages:[
    {role:'system',content:'You are a revenue-minded social content strategist. Create original, useful, non-spammy content. Do not invent facts, endorsements, or earnings claims. If monetization is involved, include a clear disclosure placeholder. Return content only, with a strong hook, useful body, and CTA.'},
    {role:'user',content:`Create a ${format} for ${platform}. Topic: ${topic}. Goal: ${goal}. Tone: ${tone}. Make it engaging, useful, and suitable for monetization where appropriate.`}
   ],temperature:0.8});content=response.choices[0]?.message?.content||'';
  }catch(e){return res.status(502).json({error:'AI generation failed. Check your API key and model configuration.',details:e.message});}
 }else{
  content=`${topic}\n\n${topic} is worth understanding before you make your next decision. Here are a few practical things to consider:\n\n• Start with the problem you are trying to solve.\n• Compare options based on quality, usefulness, and total cost.\n• Look for real-world experience and honest reviews.\n\nWhat has worked best for you? Share your experience below.\n\n[Add a relevant image or video]\n\n#${topic.replace(/[^a-zA-Z0-9]/g,'').slice(0,24)} #HelpfulTips`;
 }
 const db=await readDB();const post={id:id(),topic,platform,goal,format,tone,content,status:'pending',createdAt:new Date().toISOString(),aiGenerated:!!client};db.posts.unshift(post);await writeDB(db);res.status(201).json(post);
});
app.patch('/api/posts/:id',async(req,res)=>{
 const db=await readDB();const post=db.posts.find(p=>p.id===req.params.id);if(!post)return res.status(404).json({error:'Post not found'});
 if(req.body.content!==undefined)post.content=req.body.content;
 if(req.body.status!==undefined){if(!['pending','approved','rejected','scheduled','published'].includes(req.body.status))return res.status(400).json({error:'Invalid status'});post.status=req.body.status;}
 if(req.body.scheduledAt!==undefined)post.scheduledAt=req.body.scheduledAt;
 post.updatedAt=new Date().toISOString();await writeDB(db);res.json(post);
});
app.delete('/api/posts/:id',async(req,res)=>{const db=await readDB();db.posts=db.posts.filter(p=>p.id!==req.params.id);await writeDB(db);res.json({ok:true});});
app.get('/api/settings',async(_,res)=>res.json((await readDB()).settings));
app.put('/api/settings',async(req,res)=>{const db=await readDB();db.settings={...db.settings,...req.body};await writeDB(db);res.json(db.settings);});
app.post('/api/analytics/event',async(req,res)=>{const db=await readDB();const {type,value=1}=req.body;if(['views','clicks','conversions','revenue'].includes(type))db.metrics[type]+=Number(value)||0;await writeDB(db);res.json(db.metrics);});
app.get('*',(req,res)=>res.sendFile(path.join(process.cwd(),'public','index.html')));
app.listen(PORT,()=>console.log(`AutoRevenue AI running on port ${PORT}`));
