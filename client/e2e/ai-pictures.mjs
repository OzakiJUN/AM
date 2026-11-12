// Real runner and memory, fake model/browser bytes. Assert actual side effects.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const state={replies:[],sent:[],uploaded:[],captures:0,saved:[]};
globalThis.__amPictures=state;
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
const server=await createServer({server:{middlewareMode:true,hmr:false},plugins:[{
  name:'picture-boundaries',enforce:'pre',
  transform(code,id){if(id.endsWith('/src/lib/ai/runner.ts'))return code.replace("from '../transport'","from 'virtual:picture-net'").replace("from './tools'","from 'virtual:picture-tools'")+'\nexport const testPictures={reply,runs};';},
  resolveId(id){if(id.startsWith('virtual:picture-'))return '\0'+id;},
  load(id){
    if(id==='\0virtual:picture-net')return `
      export async function secretDelete(){};export async function secretGet(){return null};export async function secretSet(){};
      export async function aiRequest(url,headers,body,onChunk){const delta=globalThis.__amPictures.replies.shift()??{content:'[skip]'};onChunk('data: '+JSON.stringify({model:'m',choices:[{delta}]})+'\\n\\n');return 200;}`;
    if(id==='\0virtual:picture-tools')return `
      export async function loadMcpTools(){return {defs:[],map:new Map(),errors:[]}};export function stopMcp(){};
      export const biliLogin={status:async()=>({login:false,name:''})};
      export async function execTool(name,args,ctx){
        if(name==='send_picture'||name==='keep_picture')return {text:await ctx.self.picture(name==='keep_picture',args,async limit=>{globalThis.__amPictures.captures++;return {data:btoa('png'),mime:'image/png',source:'https://example.com/fish?token=secret',title:'星星鱼',captured:false};})};
        return {text:'页面图片'};
      }`;
  },
}]});
try{
  const {testPictures}=await server.ssrLoadModule('/src/lib/ai/runner.ts');
  const {defaultSettings}=await server.ssrLoadModule('/src/lib/ai/persona.ts');
  const {emptyMemory,parseMemory}=await server.ssrLoadModule('/src/lib/ai/memory.ts');
  const {useProviders}=await server.ssrLoadModule('/src/lib/ai/keys.ts');
  useProviders.setState({loaded:true,list:[{id:'p',name:'X',kind:'openai',baseUrl:'https://example.com/v1',key:'fake'}]});
  const settings={...defaultSettings(),model:'m',providerId:'p'};
  const view={status:'online',convs:{'10':{id:'10',kind:'dm',peerId:'1',members:[]}},messages:{'10':[]},replyTargets:{},games:{},users:{'1':{id:'1',type:'human',name:'主人'}}};
  let serial=100;
  const run={serverId:'srv',ai:{user:{id:'2',name:'小鱼',ownerId:'1'}},settings,busy:new Set(),again:new Set(),pending:new Map(),sends:new Map(),helper:{cmds:[],at:Date.now()},memory:emptyMemory(),memoryLoaded:true,memoryAt:0,memoryQueue:Promise.resolve(),s:{
    view,nameOf:()=> '主人',sendTyping:()=>{},uploadLimit:async()=>1024,
    upload:async file=>{state.uploaded.push(file);return {id:BigInt(serial++),isImage:true};},
    sendPicture:async(conv,id)=>{if(state.failSend)throw new Error('offline');state.sent.push({kind:'image',id});},
    sendText:async(conv,text)=>state.sent.push({kind:'text',text}),
    putClientState:async data=>{state.saved.push(JSON.parse(new TextDecoder().decode(data)));return state.saved.length;},
  }};
  testPictures.runs.set('srv|2',run);
  const call=(name,args={})=>({tool_calls:[{index:0,id:'call',function:{name,arguments:JSON.stringify(args)}}]});
  // Block even when send_picture is the very first browser operation.
  state.replies.push(call('send_picture'),{content:'[skip]'});
  await testPictures.reply(run,'10',{idle:true,silent:true,note:'自己浏览'});
  assert.equal(state.captures,0);assert.equal(state.sent.length,0);
  state.replies.push(call('browser_images'),call('keep_picture',{n:1,text:'星星鱼真好看'}),call('send_picture'),{content:'看到星星鱼了，想分享这张照片。'});
  await testPictures.reply(run,'10',{idle:true,silent:true,note:'自己浏览'});
  assert.equal(state.captures,1);assert.equal(state.sent.length,0);assert.equal(state.uploaded[0].type,'image/png');
  let pic=run.memory.pictures[0];
  assert.ok(run.memory.events.some(e=>e.id===pic.activity&&e.text.includes('星星鱼')));
  assert.equal(pic.source,'https://example.com/fish');
  // Restore like a different device; skip and failed sends retain the queue.
  run.memory=parseMemory(JSON.stringify(run.memory));
  state.replies.push({content:'[skip]'});
  await testPictures.reply(run,'10',{shareFind:pic.activity,note:'分享之前刷到的图'});
  assert.equal(run.memory.pictures.length,1);assert.ok(!run.memory.shared.includes(pic.activity));
  state.failSend=true;state.replies.push({content:'这条星星鱼好看'});
  await testPictures.reply(run,'10',{shareFind:pic.activity,note:'分享'});
  assert.equal(run.memory.pictures.length,1);assert.ok(!run.memory.shared.includes(pic.activity));
  state.failSend=false;state.sent=[];state.replies.push({content:'这条星星鱼好看'});
  await testPictures.reply(run,'10',{shareFind:pic.activity,note:'分享'});
  assert.deepEqual(state.sent.map(s=>s.kind),['text','image','text']);
  assert.equal(state.sent[1].id,pic.mediaId);assert.equal(run.memory.pictures.length,0);assert.ok(run.memory.shared.includes(pic.activity));
  pic={...pic,at:Date.now()-24*3600_000};run.memory.pictures=[pic];state.sent=[];
  state.replies.push({content:'之前刷到一条星星鱼'});
  await testPictures.reply(run,'10',{shareFind:pic.activity,note:'分享'});
  assert.ok(!state.sent.some(s=>s.kind==='image'));
  view.messages['10']=[{id:'1',seq:1,senderId:'1',time:Date.now(),body:{kind:'text',text:'把网页图发来'}}];
  state.sent=[];state.replies.push(call('send_picture',{n:1,text:'给你看'}),{content:'[skip]'});
  await testPictures.reply(run,'10');
  assert.deepEqual(state.sent.map(s=>s.kind),['image','text']);assert.match(state.sent[1].text,/给你看\n出处：https:\/\/example.com\/fish/);
  console.log('picture upload, idle isolation, restart, skip, failure, expiry and sharing ok');
}finally{await server.close();delete globalThis.__amPictures;}
