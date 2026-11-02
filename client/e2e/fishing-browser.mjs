// Optional: install playwright, then run node e2e/fishing-browser.mjs from client/.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(process.env.AM_TEST_PLAYWRIGHT ?? 'playwright');
const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(client, `.fishing-test-${process.pid}`);
const rules = JSON.parse(readFileSync(resolve(client, '../server/internal/game/fishing_rules.json'), 'utf8'));
mkdirSync(dir);
writeFileSync(resolve(dir, 'index.html'), '<html lang="zh"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./main.jsx"></script></html>');
writeFileSync(resolve(dir, 'main.jsx'), `
import React from'react';import{createRoot}from'react-dom/client';
import{FishingWindow}from'../src/app/Fishing';import{FishingWidget}from'../src/app/widgets/Fishing';
import{addServer}from'../src/lib/store';import'../src/styles.css';
const rules=${JSON.stringify(rules)};
const s=addServer({name:'测试服务器',endpoint:{address:'127.0.0.1:8443',plain:true}});
const users=Object.fromEntries(['你','晚星','泡泡','小鱼'].map((name,i)=>[String(i+1),{id:String(i+1),name,type:i===3?'ai':'human',avatarId:'0'}]));
const fish=rules.catalog.slice(0,6).map((f,i)=>({id:String(1000+i),species:f.id,length_cm:f.average_cm*(i%2?1.7:.3),grade:i%5,value:200+i*100,caught_by:'1',at:1}));
const account={version:1,coins:50000,fish,records:Object.fromEntries(fish.map((f,i)=>[f.species+':'+(i%2?'max':'min'),f])),cards:Object.fromEntries(rules.catalog.slice(0,25).map(f=>['3:'+f.id,1])),badges:[0,0,0,1,0],packs:3,tools:{speed:2,glove:1},equipped:['speed','glove'],auto_at:0,steal_at:0,ward_at:0,room:'888',last:'钓到了星星鱼，价值 150 金币',opened:['0:f001','2:f046','3:f061','4:f100']};
const seats=Array.from({length:12},(_,i)=>({user_id:i<4?String(i+1):'0',bite_at:Date.now()-1000,expires_at:Date.now()+200000}));
const g={id:'888',convId:'777',kind:'fishing',hostId:'1',status:'playing',players:Object.keys(users).map(userId=>({userId})),applicants:[],autoApprove:true,waitingOn:[],state:{turn:-1,pond:{now:Date.now(),seats}},createdAt:1,updatedAt:1};
s.view={...s.view,id:s.record.id,status:'online',me:users['1'],users,games:{[g.id]:g}};
s.fishingRules=async()=>rules;s.fishingAccount=async()=>structuredClone(account);s.fishingShowcase=async()=>structuredClone(account);
s.refreshGame=async()=>({...g,state:{...g.state,pond:{...g.state.pond,now:Date.now()}}});
s.fishingAction=async(req)=>{window.shopCalls=(window.shopCalls||0)+1;if(req.action==='buy_pack'){account.coins-=rules.pack_price;account.packs++}return structuredClone(account)};s.actGame=async()=>g;
function Preview(){return <main className="mx-auto max-w-5xl space-y-8 bg-white p-5 text-slate-800"><FishingWindow v={s.view} g={g}/><section className="grid grid-cols-3 gap-4" aria-label="主页收藏组件">{['fishing_fish','fishing_cards','fishing_badges'].map(kind=><div key={kind} className="h-64 rounded-2xl border" data-testid={kind}><FishingWidget w={{kind,w:2,h:2,config:{ids:kind==='fishing_fish'?Object.keys(account.records).slice(0,2):Object.keys(account.cards).slice(0,4),mode:'cards'}}} ctx={{v:s.view,target:'1'}}/></div>)}</section></main>}
createRoot(document.getElementById('root')).render(<Preview/>);window.fixture={g,account};
`);
let server, browser;
try {
 server = await createServer({ root: client, server: { port: 0, strictPort: false } }); await server.listen();
 const url = server.resolvedUrls.local[0] + dir.split('/').at(-1) + '/index.html';
 browser = await chromium.launch({ executablePath: process.env.AM_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
 const page = await browser.newPage({ viewport: { width: 1200, height: 1250 } }); const errors = [];
 page.on('pageerror', e => errors.push(e.message));
 await page.goto(url);const root=page.getByTestId('fishing-game'); await root.getByRole('button', { name: '收杆', exact: true }).waitFor();
 assert.equal(await page.getByRole('button', { name: /^坐到/ }).count(), 8);
 assert.equal(await root.getByRole('button', { name: '收杆', exact: true }).isEnabled(), true);
 await page.screenshot({ path: '/tmp/fishing-pond.png', fullPage: true });
 const before = await page.evaluate(() => JSON.stringify(window.fixture.g));
 await page.getByRole('tab', { name: '商店', exact: true }).click(); assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.g)), before);
 await page.getByRole('button', { name: '装备商店', exact: true }).click(); await page.getByText('疾风钓竿', { exact: true }).waitFor();
 await page.screenshot({ path: '/tmp/fishing-tools.png', fullPage: true });
 await page.getByRole('button', { name: '卡包与收藏', exact: true }).click(); await page.getByRole('button', { name: /买卡包/ }).click();
 await page.waitForFunction(() => window.shopCalls === 1); assert.equal(await page.evaluate(() => window.fixture.account.packs), 4);
 await page.screenshot({ path: '/tmp/fishing-cards.png', fullPage: true });
 await page.getByRole('tab', { name: '鱼类图鉴' }).click(); assert.equal(await page.getByRole('img').count() >= 100, true);
 await page.setViewportSize({ width: 390, height: 900 }); await page.getByRole('tab', { name: '鱼塘', exact: true }).click();
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 await page.screenshot({ path: '/tmp/fishing-mobile.png', fullPage: true }); assert.deepEqual(errors, []);
 console.log('fishing UI: twelve seats, local shop, one purchase, 100 species, widgets and mobile width ok');
} finally { await browser?.close(); await server?.close(); rmSync(dir, { recursive: true, force: true }); }
