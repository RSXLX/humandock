import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/server.js';
import { Database } from '../../apps/api/src/storage.js';
import { CRITERIA, type Task } from '../../packages/domain/src/model.js';
let app:FastifyInstance;
let clock=Date.UTC(2026,10,18);
type Actor={cookie:string;csrf:string};
let buyer:Actor,reviewer:Actor,outsider:Actor;
async function login(role:string):Promise<Actor>{const r=await app.inject({method:'POST',url:'/v1/demo/session',payload:{role}});assert.equal(r.statusCode,200);return {cookie:r.cookies[0].name+'='+r.cookies[0].value,csrf:r.json().csrfToken};}
function headers(a:Actor,key:string=randomUUID()){return {cookie:a.cookie,'x-csrf-token':a.csrf,'idempotency-key':key};}
async function post(a:Actor,url:string,body:unknown,key?:string){return app.inject({method:'POST',url,headers:headers(a,key),payload:body as Record<string,unknown>});}
async function action(a:Actor,t:Task,name:string,body:Record<string,unknown>={}){const r=await post(a,`/v1/tasks/${t.id}/${name}`,{expectedVersion:t.version,...body});assert.equal(r.statusCode,200,r.body);return r.json().task as Task;}
async function task(){const r=await post(buyer,'/v1/tasks',{title:'Studio battery campaign',sourceText:'Up to 10 hours of playback.',facts:'Battery life is up to 10 hours in laboratory testing.',channel:'tiktok_text',locale:'en-US'});assert.equal(r.statusCode,200,r.body);return r.json().task as Task;}
async function reviewed(verdict='PASS'){let t=await task();t=await action(buyer,t,'quotes');t=await action(buyer,t,'fund');t=await action(reviewer,t,'accept-assignment');return action(reviewer,t,'reviews',{reviewedText:'Up to 10 hours of playback in laboratory testing.',verdict,summary:'Reviewed the supplied claims against the product fact sheet.',checks:CRITERIA.map(criterion=>({criterion,result:'OK',comment:'Checked against the brief.',evidenceRefs:['facts']}))});}
before(async()=>{app=await buildApp({database:new Database({dataDir:'memory://'}),now:()=>clock});buyer=await login('buyer');reviewer=await login('reviewer');outsider=await login('outsider');});
after(async()=>{await app.close();});

test('readiness does not claim a live ME deployment',async()=>{const r=await app.inject('/v1/health');assert.equal(r.json().mode,'demo');assert.equal(r.json().chain.status,'not_configured');assert.equal(r.json().ai.mode,'rules');});
test('authentication, CSRF and cross-origin isolation',async()=>{
  assert.equal((await app.inject('/v1/tasks')).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/tasks',headers:{cookie:buyer.cookie},payload:{}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/v1/demo/session',headers:{origin:'https://attacker.invalid'},payload:{role:'buyer'}})).statusCode,403);
});
test('freezes input and keeps salts private',async()=>{let t=await task();t=await action(buyer,t,'quotes');assert.ok(t.sourceCommitment);assert.ok(!('secrets' in t));assert.equal(t.quote!.currency,'DEMO');assert.equal(t.timeline.some(e=>'txHash' in e),false);const r=await post(buyer,`/v1/tasks/${t.id}/quotes`,{expectedVersion:t.version});assert.equal(r.json().error.code,'QUOTE_ALREADY_FROZEN');});
test('funding retries are idempotent and conflicting key reuse fails',async()=>{
  let t=await task();t=await action(buyer,t,'quotes');const key=randomUUID(),url=`/v1/tasks/${t.id}/fund`,body={expectedVersion:t.version};
  const [a,b]=await Promise.all([post(buyer,url,body,key),post(buyer,url,body,key)]);
  assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);assert.deepEqual(a.json(),b.json());
  const c=await post(buyer,url,{expectedVersion:t.version+1},key);assert.equal(c.json().error.code,'IDEMPOTENCY_CONFLICT');
  const stale=await post(buyer,`/v1/tasks/${t.id}/cancel`,body);assert.equal(stale.json().error.code,'VERSION_CONFLICT');
});
test('other organizations and buyers cannot act as the reviewer',async()=>{
  let t=await task();assert.equal((await app.inject({url:`/v1/tasks/${t.id}`,headers:{cookie:outsider.cookie}})).statusCode,404);
  assert.equal((await app.inject({url:`/v1/tasks/${t.id}`,headers:{cookie:reviewer.cookie}})).statusCode,404);
  t=await action(buyer,t,'quotes');t=await action(buyer,t,'fund');
  const r=await post(buyer,`/v1/tasks/${t.id}/accept-assignment`,{expectedVersion:t.version});assert.equal(r.statusCode,403);
});
test('complete review, separate approval, exact-byte export, mutation attack and revocation',async()=>{
  let t=await reviewed();t=await action(buyer,t,'approvals',{versionId:t.report!.reviewedVersionId,expiresInHours:24});
  assert.equal(t.status,'SUBMITTED');const approvedId=t.approval!.versionId,approvalId=t.approval!.id;
  const e=await post(buyer,'/v1/exports',{taskId:t.id,versionId:approvedId,approvalId});assert.equal(e.statusCode,200,e.body);const exportId=e.json().export.id;
  const download=await app.inject({url:`/v1/exports/${exportId}/download`,headers:{cookie:buyer.cookie}});assert.equal(download.body,'Up to 10 hours of playback in laboratory testing.');
  const receipt=await app.inject({url:`/v1/exports/${exportId}/receipt`,headers:{cookie:buyer.cookie}});assert.equal(receipt.json().chain,null);assert.match(receipt.json().notice,/LOCAL DEMO/);
  t=await action(buyer,t,'versions',{text:'Up to 100 hours of playback!'});
  const attack=await post(buyer,'/v1/exports',{taskId:t.id,versionId:t.currentVersionId,approvalId});assert.equal(attack.json().error.code,'APPROVAL_VERSION_MISMATCH');
  assert.equal((await app.inject({url:`/v1/exports/${exportId}/download`,headers:{cookie:outsider.cookie}})).statusCode,404);
  t=await action(buyer,t,'revoke');
  const denied=await app.inject({url:`/v1/exports/${exportId}/download`,headers:{cookie:buyer.cookie}});assert.equal(denied.json().error.code,'APPROVAL_EXPIRED_OR_REVOKED');
  t=await action(buyer,t,'accept-service');assert.equal(t.closureReason,'NORMAL');
});
test('BLOCK service gets paid, approval fails, withdrawal cannot double spend',async()=>{
  const balanceBefore=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();
  let t=await reviewed('BLOCK');const r=await post(buyer,`/v1/tasks/${t.id}/approvals`,{expectedVersion:t.version,versionId:t.report!.reviewedVersionId,expiresInHours:24});assert.equal(r.json().error.code,'REVIEW_NOT_PASS');
  t=await action(buyer,t,'accept-service');
  const b=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();assert.equal(BigInt(b.claimableAtoms)-BigInt(balanceBefore.claimableAtoms),800000000000000000n);
  const withdrawal=await post(reviewer,'/v1/withdrawals',{});assert.equal(withdrawal.statusCode,200,withdrawal.body);assert.equal(withdrawal.json().claimableAtoms,'0');
  const again=await post(reviewer,'/v1/withdrawals',{});assert.equal(again.json().error.code,'NO_CLAIMABLE_BALANCE');
});
test('cancel and timeout refunds are real persisted local allocations',async()=>{
  let t=await task();t=await action(buyer,t,'quotes');t=await action(buyer,t,'fund');
  const before=(await app.inject({url:'/v1/balances',headers:{cookie:buyer.cookie}})).json();t=await action(buyer,t,'cancel');
  const after=(await app.inject({url:'/v1/balances',headers:{cookie:buyer.cookie}})).json();assert.equal(BigInt(after.claimableAtoms)-BigInt(before.claimableAtoms),1000000000000000000n);
  let due=await task();due=await action(buyer,due,'quotes');due=await action(buyer,due,'fund');
  const early=await post(buyer,`/v1/tasks/${due.id}/timeouts`,{expectedVersion:due.version});assert.equal(early.json().error.code,'DEADLINE_NOT_REACHED');
  clock=Date.parse(due.quote!.acceptUntil);buyer=await login('buyer');due=await action(buyer,due,'timeouts');assert.equal(due.closureReason,'UNASSIGNED_TIMEOUT');
});
test('ME mode cannot silently turn on demo finance or identity',async()=>{
  const me=await buildApp({mode:'me',database:new Database({dataDir:'memory://'})});
  try {const r=await me.inject({method:'POST',url:'/v1/demo/session',payload:{role:'buyer'}});assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'ME_INTEGRATION_PENDING');}finally{await me.close();}
});
