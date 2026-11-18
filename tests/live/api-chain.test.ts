import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Hex } from 'viem';
import { buildApp } from '../../apps/api/src/server.js';
import { Database } from '../../apps/api/src/storage.js';
import { MeWorkflow, type ChainIntent } from '../../apps/api/src/live-workflow.js';
import { type LiveSettings } from '../../apps/api/src/live-config.js';
import { deployLocalFixture } from '../../packages/me/src/local-fixture.js';
import { MeIdentityRejectedError } from '../../packages/me/src/identity.js';
import { CRITERIA, type Task } from '../../packages/domain/src/model.js';

type Actor={index:number;cookie:string;csrf:string};
let fixture:Awaited<ReturnType<typeof deployLocalFixture>>,app:Awaited<ReturnType<typeof buildApp>>,db:Database,settings:LiveSettings;
let buyer:Actor,reviewer:Actor,outsider:Actor,identityAvailable=true,snapshot:string,completed:Task;
const input={title:'Chain verified battery campaign',sourceText:'Up to 10 hours of playback.',facts:'Battery life is up to 10 hours in laboratory testing.',channel:'tiktok_text',locale:'en-US'};
const report={reviewedText:'Up to 10 hours of playback in laboratory testing.',verdict:'PASS',summary:'Reviewed all supplied claims against the product fact sheet.',checks:CRITERIA.map(criterion=>({criterion,result:'OK',comment:'Verified against the supplied facts.',evidenceRefs:['facts']}))};
const headers=(a:Actor,key:string=randomUUID())=>({cookie:a.cookie,'x-csrf-token':a.csrf,'idempotency-key':key});
const post=(a:Actor,url:string,body:unknown={},key?:string)=>app.inject({method:'POST',url,headers:headers(a,key),payload:body as any});
async function ok(a:Actor,url:string,body:unknown={},key?:string){const r=await post(a,url,body,key);assert.equal(r.statusCode,200,r.body);return r.json();}
async function readTask(a:Actor,id:string){const r=await app.inject({url:`/v1/tasks/${id}`,headers:{cookie:a.cookie}});assert.equal(r.statusCode,200,r.body);return r.json().task as Task;}
async function login(index:number,refresh=true):Promise<Actor>{
  const a=fixture.accounts[index],challenge=await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:a.address,chainId:fixture.config.chainId}});
  assert.equal(challenge.statusCode,200,challenge.body);
  const browserCookie=challenge.cookies.find(c=>c.name==='hd_challenge')!;
  const signature=await a.signMessage({message:challenge.json().message});
  const r=await app.inject({method:'POST',url:'/v1/auth/verify',headers:{cookie:`${browserCookie.name}=${browserCookie.value}`},payload:{challengeId:challenge.json().challengeId,signature}});
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().user.identity.status,'pending');
  const sessionCookie=r.cookies.find(c=>c.name==='hd_session')!,actor={index,cookie:`hd_session=${sessionCookie.value}`,csrf:r.json().csrfToken};
  if(refresh){const identity=await ok(actor,'/v1/me/identity/refresh');assert.equal(identity.user.identity.status,'local_test');}
  return actor;
}
async function newTask(reviewerIndex=7){let t=(await ok(buyer,'/v1/tasks',{...input,reviewerWallet:fixture.accounts[reviewerIndex].address})).task as Task;t=(await ok(buyer,`/v1/tasks/${t.id}/quotes`,{expectedVersion:t.version})).task;return t;}
async function prepare(a:Actor,action:string,t?:Task,payload?:unknown){return (await ok(a,'/v1/me/intents',{action,...(t?{taskId:t.id,expectedVersion:t.version}:{}),payload:payload??{}})).intent as ChainIntent;}
async function send(a:Actor,intent:ChainIntent){
  if(intent.status==='awaiting_signature')intent=(await ok(a,`/v1/me/intents/${intent.id}/signature`,{signature:await fixture.accounts[a.index].signTypedData(intent.typedData as any)})).intent;
  const tx=intent.transaction!;
  const hash=await fixture.wallets[a.index].sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value)});
  await ok(a,`/v1/me/intents/${intent.id}/broadcast`,{txHash:hash});
  const result=await ok(a,`/v1/me/intents/${intent.id}/reconcile`);
  assert.equal(result.intent.status,'confirmed',JSON.stringify(result));assert.equal(result.intent.applied,true,JSON.stringify(result));
  assert.match(result.intent.block.hash,/^0x[0-9a-f]{64}$/i);assert.equal(result.intent.txHash,hash);
  return result as {intent:ChainIntent;task?:Task};
}
before(async()=>{
  fixture=await deployLocalFixture();db=new Database({dataDir:'memory://'});
  settings={network:fixture.config,deployment:fixture.deployment,client:fixture.client,
    signers:{quote:fixture.quoteSigner,assignment:fixture.assignmentSigner,delivery:fixture.deliveryGateSigner},reviewers:[fixture.reviewer.address,fixture.accounts[9].address],identitySecret:'explicit-local-only-identity-secret-at-least-32-characters',
    reviewerFeeWei:8_000_000_000_000_000n,platformFeeWei:2_000_000_000_000_000n,unitsVerified:true,publicRpcUrl:fixture.config.rpcUrl,syncIntervalMs:0,gasCharging:'exact-wei',
    identityVerifier:async wallet=>{if(!identityAvailable)throw new MeIdentityRejectedError('Fixture identity unavailable');return {canonicalDid:wallet.toLowerCase()===fixture.accounts[9].address.toLowerCase()?fixture.buyer.address.toLowerCase():wallet.toLowerCase(),wallet,kycLevel:1,observedAt:new Date().toISOString(),policyReference:'explicit-local-test-fixture',localTest:true};}};
  app=await buildApp({mode:'me',database:db,liveSettings:settings});await app.meWorkflow!.sync();
  buyer=await login(6);reviewer=await login(7);outsider=await login(8);
});
after(async()=>{await app?.close();await fixture?.close();});

test('wallet challenge is browser-bound, chain-bound, one-use and separate from identity',async()=>{
  const config=(await app.inject('/v1/me/config')).json();assert.equal(config.writesEnabled,true);assert.equal(config.localTest,true);assert.equal(config.network.nativeSymbol,'LOCAL');
  const invalid=await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:fixture.buyer.address,chainId:400}});assert.equal(invalid.json().error.code,'CHAIN_MISMATCH');
  const c=await app.inject({method:'POST',url:'/v1/auth/challenge',payload:{address:fixture.accounts[10].address,chainId:31337}}),body=c.json();
  assert.match(body.message,/localhost:3000/);assert.match(body.message,/Chain ID: 31337/);assert.match(body.message,/does not authorize a transaction/);
  const signature=await fixture.accounts[10].signMessage({message:body.message});
  const payload={challengeId:body.challengeId,signature},cookie=`hd_challenge=${c.cookies[0].value}`;
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/verify',payload})).json().error.code,'LOGIN_BROWSER_MISMATCH');
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/verify',headers:{cookie:'hd_challenge=other-browser'},payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/verify',headers:{cookie},payload:{...payload,signature:await fixture.accounts[11].signMessage({message:body.message})}})).json().error.code,'LOGIN_SIGNATURE_INVALID');
  const success=await app.inject({method:'POST',url:'/v1/auth/verify',headers:{cookie},payload});assert.equal(success.statusCode,200);assert.equal(success.json().user.identity.status,'pending');
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/verify',headers:{cookie},payload})).json().error.code,'LOGIN_CHALLENGE_EXPIRED');
  assert.equal((await app.inject({method:'POST',url:'/v1/demo/session',payload:{role:'buyer'}})).statusCode,503);
  assert.equal((await app.inject({method:'POST',url:'/v1/me/intents',headers:{cookie:buyer.cookie},payload:{action:'withdraw'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/challenge',headers:{origin:'https://attacker.invalid'},payload:{address:fixture.buyer.address,chainId:31337}})).statusCode,403);
});

test('same canonical identity cannot be an independent reviewer, including another wallet',async()=>{
  const alias=await login(9);let t=await newTask(9);t=(await send(buyer,await prepare(buyer,'fund',t))).task!;
  const r=await post(alias,'/v1/me/intents',{action:'accept-assignment',taskId:t.id,expectedVersion:t.version});assert.equal(r.statusCode,403);assert.match(r.json().error.code,/REVIEWER_REQUIRED|SELF_REVIEW_FORBIDDEN/);
  await send(buyer,await prepare(buyer,'cancel',t));
  await send(buyer,await prepare(buyer,'withdraw',undefined,{receiver:fixture.buyer.address}));
});

test('a transaction hash cannot fabricate another wallet funding or claim another actor transaction',async()=>{
  let t=await newTask(),other=await newTask();const victim=await prepare(buyer,'fund',t),wrong=await prepare(buyer,'fund',other);
  const tx=victim.transaction!,hash=await fixture.wallets[6].sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value)});
  const mismatch=await post(buyer,`/v1/me/intents/${wrong.id}/broadcast`,{txHash:hash});assert.equal(mismatch.statusCode,400);assert.equal(mismatch.json().error.code,'INTENT_MISMATCH');
  await app.meWorkflow!.sync();
  const wrongView=(await app.inject({url:`/v1/me/intents/${wrong.id}`,headers:{cookie:buyer.cookie}})).json().intent;assert.equal(wrongView.status,'ready');assert.equal(wrongView.applied,false);
  await ok(buyer,`/v1/me/intents/${victim.id}/broadcast`,{txHash:hash});const good=await ok(buyer,`/v1/me/intents/${victim.id}/reconcile`);assert.equal(good.intent.applied,true);
  assert.equal((await app.inject({url:`/v1/me/intents/${victim.id}`,headers:{cookie:outsider.cookie}})).statusCode,404);
  t=good.task;await send(buyer,await prepare(buyer,'cancel',t));await send(buyer,await prepare(buyer,'withdraw'));
});

test('pending reconciliation is fresh with the same idempotency key; confirmed events apply exactly once',async()=>{
  let t=await newTask();const preparationKey=randomUUID(),preparation={action:'fund',taskId:t.id,expectedVersion:t.version,payload:{}};
  const intent=(await ok(buyer,'/v1/me/intents',preparation,preparationKey)).intent as ChainIntent,tx=intent.transaction!;
  await fixture.provider.request({method:'miner_stop',params:[]});
  try {
    const hash=await fixture.wallets[6].sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value),gas:500_000n});await ok(buyer,`/v1/me/intents/${intent.id}/broadcast`,{txHash:hash});
    const key=randomUUID(),url=`/v1/me/intents/${intent.id}/reconcile`;
    const pending=await ok(buyer,url,{},key);assert.equal(pending.intent.status,'broadcast');assert.equal(pending.intent.applied,false);
    await fixture.provider.request({method:'miner_start',params:[1]});
    const confirmed=await ok(buyer,url,{},key);assert.equal(confirmed.intent.status,'confirmed');assert.equal(confirmed.intent.applied,true);
    const retriedPreparation=await ok(buyer,'/v1/me/intents',preparation,preparationKey);assert.equal(retriedPreparation.intent.status,'confirmed');assert.equal(retriedPreparation.intent.txHash,hash);
    t=confirmed.task;
    const before=(await db.query('SELECT id FROM hd_me_ledger WHERE task_id=$1',[t.id])).rows.length;
    await app.meWorkflow!.sync();await ok(buyer,url,{},key);await app.meWorkflow!.sync();
    assert.equal((await db.query('SELECT id FROM hd_me_ledger WHERE task_id=$1',[t.id])).rows.length,before);
  } finally {await fixture.provider.request({method:'miner_start',params:[1]});}
  await send(buyer,await prepare(buyer,'cancel',t));await send(buyer,await prepare(buyer,'withdraw'));
});

test('real local contract flow: wallet, identity, funding, dual-signed delivery, independent approval, allocation, withdrawal and export revocation',async()=>{
  let t=await newTask();snapshot=await fixture.provider.request({method:'evm_snapshot',params:[]}) as string;
  assert.equal(t.executionMode,'me');assert.equal(t.quote!.currency,'LOCAL');assert.equal(t.chain!.taskId,undefined);
  const before=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();assert.equal(before.claimableAtoms,'0');
  const fund=await prepare(buyer,'fund',t);assert.equal((await readTask(buyer,t.id)).status,'DRAFT');
  t=(await send(buyer,fund)).task!;assert.equal(t.status,'FUNDED');assert.ok(t.chain!.taskId);assert.ok(t.timeline.some(e=>e.txHash));
  t=(await send(reviewer,await prepare(reviewer,'accept-assignment',t))).task!;assert.equal(t.status,'ASSIGNED');
  const delivery=await prepare(reviewer,'reviews',t,report);assert.equal(delivery.status,'awaiting_signature');
  const wrongSignature=await post(reviewer,`/v1/me/intents/${delivery.id}/signature`,{signature:await fixture.buyer.signTypedData(delivery.typedData as any)});assert.equal(wrongSignature.statusCode,403);
  t=(await send(reviewer,delivery)).task!;assert.equal(t.report!.verdict,'PASS');assert.equal(t.status,'SUBMITTED');
  assert.equal((await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json().claimableAtoms,'0');
  t=(await send(buyer,await prepare(buyer,'approvals',t,{versionId:t.report!.reviewedVersionId,expiresInHours:24}))).task!;assert.equal(t.status,'SUBMITTED');
  const ex=await ok(buyer,'/v1/exports',{taskId:t.id,versionId:t.report!.reviewedVersionId,approvalId:t.approval!.id});
  const receipt=await app.inject({url:`/v1/exports/${ex.export.id}/receipt`,headers:{cookie:buyer.cookie}});assert.equal(receipt.statusCode,200,receipt.body);assert.equal(receipt.json().chain.chainId,31337);assert.match(receipt.json().notice,/LOCAL TEST CHAIN/);
  assert.equal((await app.inject({url:`/v1/exports/${ex.export.id}/download`,headers:{cookie:buyer.cookie}})).body,report.reviewedText);
  assert.equal((await app.inject({url:`/v1/exports/${ex.export.id}/download`,headers:{cookie:outsider.cookie}})).statusCode,404);
  identityAvailable=false;
  buyer=await login(6,false);reviewer=await login(7,false);
  assert.equal((await readTask(buyer,t.id)).id,t.id,'buyer exits must remain accessible after a fresh login without fresh KYC');
  t=(await send(buyer,await prepare(buyer,'accept-service',t))).task!;assert.equal(t.closureReason,'NORMAL');
  const allocations=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();assert.equal(allocations.claimableAtoms,settings.reviewerFeeWei.toString());assert.equal(allocations.reconciliationStatus,'matched');
  const badReceiver=await post(reviewer,'/v1/me/intents',{action:'withdraw',payload:{receiver:fixture.buyer.address}});assert.equal(badReceiver.json().error.code,'WITHDRAWAL_RECEIVER_MISMATCH');
  const withdrawal=await send(reviewer,await prepare(reviewer,'withdraw',undefined,{receiver:fixture.reviewer.address}));
  assert.equal(withdrawal.intent.reconciliation!.status,'evm-only');assert.equal(withdrawal.intent.reconciliation!.evmBalanced,true);assert.equal(withdrawal.intent.reconciliation!.bankVerified,false);
  const afterBalance=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();assert.equal(afterBalance.claimableAtoms,'0');assert.equal(afterBalance.withdrawnAtoms,settings.reviewerFeeWei.toString());assert.equal(afterBalance.reconciliationStatus,'matched');
  assert.equal((await post(reviewer,'/v1/me/intents',{action:'withdraw'})).json().error.code,'NO_CLAIMABLE_BALANCE');
  t=(await send(buyer,await prepare(buyer,'revoke',t))).task!;
  assert.equal((await app.inject({url:`/v1/exports/${ex.export.id}/download`,headers:{cookie:buyer.cookie}})).json().error.code,'APPROVAL_EXPIRED_OR_REVOKED');
  const blocked=await post(buyer,'/v1/tasks',{...input,reviewerWallet:fixture.reviewer.address});assert.equal(blocked.statusCode,403);assert.equal(blocked.json().error.code,'ME_IDENTITY_REQUIRED');
  identityAvailable=true;completed=t;
});

test('wallet speed-ups and confirmed nonce cancellation recover without resending an intent',async()=>{
  buyer=await login(6);
  for(const cancel of [false,true]) {
    let t=await newTask();const intent=await prepare(buyer,'fund',t),tx=intent.transaction!;
    await fixture.provider.request({method:'miner_stop',params:[]});
    try {
      const nonce=await fixture.client.getTransactionCount({address:fixture.buyer.address,blockTag:'pending'});
      const original=await fixture.wallets[6].sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value),gas:500_000n,gasPrice:2_000_000_000n,nonce,type:'legacy'});
      await ok(buyer,`/v1/me/intents/${intent.id}/broadcast`,{txHash:original});
      const replacement=await fixture.wallets[6].sendTransaction({to:cancel?fixture.buyer.address:tx.to,data:cancel?'0x':tx.data,value:cancel?0n:BigInt(tx.value),gas:500_000n,gasPrice:4_000_000_000n,nonce,type:'legacy'});
      await fixture.provider.request({method:'miner_start',params:[1]});
      const registered=await ok(buyer,`/v1/me/intents/${intent.id}/broadcast`,{txHash:replacement});
      if(cancel){assert.equal(registered.intent.status,'replaced');assert.equal(registered.intent.applied,false);assert.equal((await readTask(buyer,t.id)).status,'DRAFT');t=(await send(buyer,await prepare(buyer,'fund',t))).task!;}
      else {const confirmed=await ok(buyer,`/v1/me/intents/${intent.id}/reconcile`);assert.equal(confirmed.intent.status,'confirmed');assert.equal(confirmed.intent.txHash,replacement);assert.equal(confirmed.intent.applied,true);t=confirmed.task;}
    }finally{await fixture.provider.request({method:'miner_start',params:[1]});}
    await send(buyer,await prepare(buyer,'cancel',t));await send(buyer,await prepare(buyer,'withdraw'));
  }
});

test('reorganization is fail-closed across restart and canonical replay reconstructs tasks and ledger',async()=>{
  assert.ok(snapshot && completed);await fixture.provider.request({method:'evm_revert',params:[snapshot]});await fixture.provider.request({method:'evm_mine',params:[]});
  await assert.rejects(app.meWorkflow!.sync());assert.equal(app.meWorkflow!.config().writesEnabled,false);
  const restarted=new MeWorkflow(db,settings);await assert.rejects(restarted.sync());assert.equal(restarted.config().writesEnabled,false);
  await app.meWorkflow!.reindex();const rebuilt=await readTask(buyer,completed.id);assert.equal(rebuilt.status,'DRAFT');assert.equal(rebuilt.report,null);assert.equal(rebuilt.approval,null);assert.equal(rebuilt.chain!.taskId,undefined);
  assert.equal((await db.query('SELECT id FROM hd_me_ledger WHERE task_id=$1',[completed.id])).rows.length,0);
  const balances=(await app.inject({url:'/v1/balances',headers:{cookie:reviewer.cookie}})).json();assert.equal(balances.withdrawnAtoms,'0');assert.equal(balances.claimableAtoms,'0');assert.equal(balances.reconciliationStatus,'matched');
  assert.equal(app.meWorkflow!.config().writesEnabled,true);await restarted.stop();
});
