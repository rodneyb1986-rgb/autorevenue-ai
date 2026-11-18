require('dotenv').config();
const express=require('express'),helmet=require('helmet'),fs=require('fs'),path=require('path');
const app=express(),PORT=process.env.PORT||3000,DATA_FILE=path.join(__dirname,'data','app-data.json'),PUBLIC=path.join(__dirname,'public');
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'1mb'}));app.use(express.static(PUBLIC));
function readData(){try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}catch{return {opportunities:[],content:[],revenue:[],settings:{niche:'',goal:''}}}}
function writeData(d){fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2))}
app.get('/api/health',(req,res)=>res.json({ok:true,app:'AutoRevenue AI',version:'1.1.0'}));
app.get('/api/data',(req,res)=>res.json(readData()));
app.post('/api/data',(req,res)=>{if(!req.body||typeof req.body!=='object')return res.status(400).json({error:'Invalid data'});writeData(req.body);res.json({ok:true})});
app.post('/api/generate',async(req,res)=>{const {type,prompt,niche}=req.body||{};if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'AI is not configured. Add OPENAI_API_KEY in Render Environment Variables.'});try{const OpenAI=require('openai'),client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});const response=await client.responses.create({model:process.env.OPENAI_MODEL||'gpt-6',input:`You are AutoRevenue AI, a practical business and content assistant. Create useful, original, monetization-focused material. Type: ${type||'content'}. Niche: ${niche||'general'}. User request: ${prompt||'Generate a strong idea.'}`});res.json({result:response.output_text||'No text returned.'})}catch(e){console.error('AI generation error:',e.message);res.status(500).json({error:'AI generation failed. Check API key, model name, and server logs.'})}});
app.get('*',(req,res)=>{const f=path.join(PUBLIC,'index.html');if(!fs.existsSync(f))return res.status(500).send('Missing public/index.html. Upload the public folder to the repository root.');res.sendFile(f)});
app.listen(PORT,()=>console.log(`AutoRevenue AI running on port ${PORT}`));
