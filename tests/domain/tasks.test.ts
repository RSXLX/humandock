import test from 'node:test';
import assert from 'node:assert/strict';
import { CRITERIA, type Check, type Verdict } from '../../packages/domain/src/model.js';
import { commitment, textHash } from '../../packages/domain/src/commitments.js';
import * as d from '../../packages/domain/src/tasks.js';
const start=Date.UTC(2026,10,18);
const buyer=d.DEMO_USERS.buyer, reviewer=d.DEMO_USERS.reviewer;
const checks:Check[]=CRITERIA.map(criterion=>({criterion,result:'OK',comment:'Compared with the supplied fact sheet.',evidenceRefs:['facts']}));
function funded() {const t=d.createTask(buyer,{title:'Battery ad',sourceText:'Up to 10 hours of playback.',facts:'Battery life: up to 10 hours under laboratory conditions.',channel:'tiktok_text',locale:'en-US'},start);d.quoteTask(t,buyer,start);d.fundTask(t,buyer,start);return t;}
function delivered(verdict:Verdict='PASS') {const t=funded();d.acceptAssignment(t,reviewer,start);d.submitReview(t,reviewer,{reviewedText:'Up to 10 hours of playback under laboratory conditions.',verdict,summary:'The final version matches the supplied product specification.',checks},start);return t;}

test('canonical commitments preserve key-order equivalence, separate domains and salts',()=>{
  const salt=`0x${'11'.repeat(32)}`,other=`0x${'22'.repeat(32)}`;
  assert.equal(commitment('SOURCE',{b:'2',a:'1'},salt),commitment('SOURCE',{a:'1',b:'2'},salt));
  assert.notEqual(commitment('SOURCE',{a:'1'},salt),commitment('FINAL',{a:'1'},salt));
  assert.notEqual(commitment('SOURCE',{a:'1'},salt),commitment('SOURCE',{a:'1'},other));
  assert.notEqual(textHash('a\n'),textHash('a'));
});
test('BLOCK review is payable but cannot be approved',()=>{
  const t=delivered('BLOCK');
  assert.throws(()=>d.approveTask(t,buyer,t.report!.reviewedVersionId,24,start),{code:'REVIEW_NOT_PASS'});
  const allocations=d.acceptService(t,buyer,start);
  assert.equal(allocations.find(a=>a.accountId===reviewer.id)!.amountAtoms,800000000000000000n);
  assert.equal(t.closureReason,'NORMAL');
});
test('approval binds exact bytes and does not settle money',()=>{
  const t=delivered();d.approveTask(t,buyer,t.report!.reviewedVersionId,24,start);
  assert.equal(t.status,'SUBMITTED');
  const old=t.report!.reviewedVersionId,approval=t.approval!.id;
  d.addVersion(t,buyer,'Up to 100 hours of playback.',start);
  assert.throws(()=>d.verifyExport(t,buyer,t.currentVersionId,approval,start),{code:'APPROVAL_VERSION_MISMATCH'});
  assert.equal(d.verifyExport(t,buyer,old,approval,start).text,'Up to 10 hours of playback under laboratory conditions.');
  t.versions.find(a=>a.id===old)!.text='Tampered';
  assert.throws(()=>d.verifyExport(t,buyer,old,approval,start),{code:'CONTENT_INTEGRITY_FAILURE'});
});
test('revocation and exact expiry reject export',()=>{
  const t=delivered();d.approveTask(t,buyer,t.report!.reviewedVersionId,24,start);
  assert.throws(()=>d.verifyExport(t,buyer,t.approval!.versionId,t.approval!.id,start+24*d.HOUR),{code:'APPROVAL_EXPIRED_OR_REVOKED'});
  d.revokeTask(t,buyer,start+1);
  assert.throws(()=>d.verifyExport(t,buyer,t.approval!.versionId,t.approval!.id,start+2),{code:'APPROVAL_EXPIRED_OR_REVOKED'});
});
test('reapproval cannot silently erase a still-active authorization',()=>{
  const t=delivered();d.approveTask(t,buyer,t.report!.reviewedVersionId,24,start);
  const prior=t.approval!.id;
  assert.throws(()=>d.approveTask(t,buyer,t.report!.reviewedVersionId,72,start+1),{code:'APPROVAL_ALREADY_ACTIVE'});
  assert.equal(d.verifyExport(t,buyer,t.report!.reviewedVersionId,prior,start+1).id,t.report!.reviewedVersionId);
  d.revokeTask(t,buyer,start+2);d.approveTask(t,buyer,t.report!.reviewedVersionId,72,start+3);
  assert.equal(t.secrets.approvalHistory?.[0].id,prior);
  assert.equal(t.secrets.approvalHistory?.[0].revokedAt,new Date(start+2).toISOString());
});
test('deadline boundaries have no overlap',()=>{
  const t=funded();const deadline=Date.parse(t.quote!.acceptUntil);
  assert.throws(()=>d.acceptAssignment(t,reviewer,deadline),{code:'ASSIGNMENT_EXPIRED'});
  const a=d.timeoutTask(t,buyer,deadline);assert.equal(a[0].amountAtoms,1000000000000000000n);
  assert.throws(()=>d.timeoutTask(t,buyer,deadline),{code:'DEADLINE_NOT_REACHED'});
});
test('dispute timeout preserves funds and platform fee is refunded',()=>{
  const t=delivered();d.openDispute(t,buyer,'Missing part of the promised analysis.',start+1);
  assert.throws(()=>d.timeoutTask(t,buyer,Date.parse(t.arbitrationUntil!)-1),{code:'DEADLINE_NOT_REACHED'});
  const a=d.timeoutTask(t,buyer,Date.parse(t.arbitrationUntil!));
  assert.equal(a.find(x=>x.accountId===reviewer.id)!.amountAtoms,400000000000000000n);
  assert.equal(a.find(x=>x.accountId===buyer.id)!.amountAtoms,600000000000000000n);
  assert.equal(a.reduce((x,y)=>x+y.amountAtoms,0n),1000000000000000000n);
  assert.ok(a.every(x=>x.amountAtoms % d.DEMO_QUANTUM===0n));
});
test('assignment, report and PASS constraints cannot be bypassed',()=>{
  const t=funded();assert.throws(()=>d.acceptAssignment(t,buyer,start),{code:'REVIEWER_REQUIRED'});
  d.acceptAssignment(t,reviewer,start);
  assert.throws(()=>d.submitReview(t,reviewer,{reviewedText:'Draft',verdict:'PASS',summary:'Human review completed.',checks:checks.map((x,i)=>i===0?{...x,result:'UNKNOWN'}:x)},start),{code:'INCONSISTENT_VERDICT'});
  assert.throws(()=>d.submitReview(t,buyer,{reviewedText:'Draft',verdict:'PASS',summary:'Attempt to self-review.',checks},start),{code:'REVIEWER_REQUIRED'});
});
