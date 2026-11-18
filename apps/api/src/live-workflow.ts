import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, hashTypedData, recoverTypedDataAddress, toHex, TransactionNotFoundError, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { commitment, randomSalt, textHash } from '../../../packages/domain/src/commitments.js';
import { CRITERIA, DomainError, publicTask, requireThat, type PrivateTask, type User } from '../../../packages/domain/src/model.js';
import * as domain from '../../../packages/domain/src/tasks.js';
import { reviewEscrowAbi, releaseRegistryAbi } from '../../../packages/me/src/generated-abis.js';
import { assignmentTypedData, approvalTypedData, deliveryTypedData, quoteTypedData, revocationTypedData, DELIVERY_SCHEMA_HASH, EXPORT_PURPOSE_HASH, Verdict, type Quote, type DeliveryEnvelope, type ApprovalIntent, type RevocationIntent } from '../../../packages/me/src/contracts.js';
import { verifyDeployment, verifyTransaction, scanContractEvents, MeChainError, type DecodedContractEvent, type PreparedTransaction, type MinedTransactionVerification } from '../../../packages/me/src/chain.js';
import { readBalanceSnapshot, reconcileWithdrawal } from '../../../packages/me/src/balances.js';
import { createCosmosBankReader } from '../../../packages/me/src/bank.js';
import type { Database, Sql } from './storage.js';
import type { IdentityEvidence, LiveSettings } from './live-config.js';
import { walletUserId } from './wallet-auth.js';

export const CHAIN_ACTIONS = ['fund','accept-assignment','reviews','accept-service','approvals','revoke','cancel','disputes','timeouts','withdraw'] as const;
export type ChainAction = typeof CHAIN_ACTIONS[number];
export type ChainIntent = {
  id: string; taskId: string | null; action: ChainAction; account: Address; chainId: number;
  status: 'awaiting_signature' | 'ready' | 'broadcast' | 'confirming' | 'confirmed' | 'reverted' | 'reorged' | 'expired' | 'rejected' | 'replaced';
  allowedTargets: Address[]; summary: { title: string; description: string; amountWei: string; symbol: string; versionId?: string; deliveryCommitment?: string; receiver?: string; withdrawalAmountWei?: string };
  expiresAt: string; typedData?: Record<string, unknown>; transaction?: PreparedTransaction; txHash?: Hex;
  confirmations: number; requiredConfirmations: number; applied: boolean;
  block?: { number: string; hash: Hex; timestamp: string }; error?: { code: string; message: string };
  reconciliation?: Record<string, unknown>;
};
type StoredIntent = { view: ChainIntent; private: { candidate?: PrivateTask; typedData?: any; gateSignature?: Hex; chainApprovalId?: Hex; expectedEvent: string; args?: unknown[]; before?: unknown; broadcastNonce?: number; previousHashes?: Hex[]; cancellationHash?: Hex } };
type TaskMeta = { baseline: PrivateTask; reviewerWallet: Address; clientRequestId: Hex; buyerPrincipal: Hex; identityKeyId: string; quote?: any; quoteSignature?: Hex; termsHash?: Hex; chainTaskId?: string; approvalChainId?: Hex; displayVersionId?: string };
type IdentityCache = { canonicalKey: string; orgId: string; wallet: Address; kycLevel: number; checkedAt: string; policyReference: string; localTest: boolean };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v);
const wire = <T>(value: T): T => JSON.parse(json(value));
const nonce = () => BigInt(`0x${randomBytes(32).toString('hex')}`);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const restoredQuote = (q: any): Quote => ({ ...q, reviewerFeeWei: BigInt(q.reviewerFeeWei), platformFeeWei: BigInt(q.platformFeeWei), quantumWei: BigInt(q.quantumWei), acceptUntil: BigInt(q.acceptUntil), expiresAt: BigInt(q.expiresAt), nonce: BigInt(q.nonce) });
const wordText = z.string().min(1).max(6000).refine(s => s.trim().length > 0 && s.trim().split(/\s+/).length <= 300);
const reviewInput = z.object({ reviewedText: wordText, verdict: z.enum(['PASS','CHANGES_REQUIRED','BLOCK']), summary: z.string().trim().min(10).max(2000), checks: z.array(z.object({ criterion: z.enum(CRITERIA), result: z.enum(['OK','ISSUE','UNKNOWN']), comment: z.string().trim().min(1).max(1500), evidenceRefs: z.array(z.string().max(200)).max(20) })).length(5) }).strict();

/** The application never holds a user's spending key and never broadcasts a user transaction. */
export class MeWorkflow {
  private deploymentReport?: Awaited<ReturnType<typeof verifyDeployment>>;
  private checkedAt = 0;
  private verification?: Promise<void>;
  private syncJob?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private syncFault?: string;
  private synchronized = false;
  constructor(readonly db: Database, readonly settings: LiveSettings | undefined, readonly now: () => number = Date.now, private configurationError = 'ME configuration is incomplete.') {}

  async start() {
    if (!this.settings) return;
    this.timer = this.settings.syncIntervalMs === 0 ? undefined : setInterval(() => { void this.sync().catch(() => undefined); }, this.settings.syncIntervalMs ?? 10_000);
    this.timer?.unref();
    void this.ensureReady().then(() => this.sync()).catch(() => undefined);
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.verification?.catch(() => undefined); await this.syncJob?.catch(() => undefined); }
  config() {
    const s = this.settings;
    if (!s) return { mode:'me', status:'not_configured', writesEnabled:false, admissionsEnabled:false, reasons:[this.configurationError], admissionReasons:[], network:null, contracts:null, confirmations:0, localTest:false };
    const reasons = !this.deploymentReport ? ['Chain and deployment verification has not completed.'] : this.syncFault ? [this.syncFault] : !this.synchronized ? ['The confirmed event cursor has not caught up.'] : [];
    const admissionReasons: string[] = [];
    if (!s.signers.quote || !s.signers.assignment || !s.signers.delivery) admissionReasons.push('Purpose-specific attestation signers are not configured.');
    if (!s.reviewers.length) admissionReasons.push('No invited reviewer wallet is configured.');
    if (!s.unitsVerified) admissionReasons.push('A matching nonzero same-block bank/EVM unit verification is required.');
    if (s.network.network !== 'local' && (!s.network.minimumKycLevel || !s.network.identityPolicyReference || !s.network.cosmosRestUrl)) admissionReasons.push('The explicit ME identity policy is incomplete.');
    if (this.deploymentReport?.admissionsPaused) admissionReasons.push('New contract admissions are paused.');
    const roles = this.deploymentReport?.roles;
    if (roles && ((s.signers.quote && !same(s.signers.quote.address,roles.quoteSigner)) || (s.signers.assignment && !same(s.signers.assignment.address,roles.assignmentSigner)) || (s.signers.delivery && !same(s.signers.delivery.address,roles.deliveryGate)))) admissionReasons.push('Attestation keys do not match the deployed role addresses.');
    return { mode:'me', status: reasons.length ? 'blocked' : 'ready', writesEnabled:reasons.length === 0, admissionsEnabled:reasons.length === 0 && admissionReasons.length === 0, reasons, admissionReasons,
      network:{kind:s.network.network,chainId:s.network.chainId,chainName:`HumanDock ${s.network.network}`,nativeSymbol:s.network.nativeSymbol,evmDecimals:18,bankDecimals:s.network.bankDecimals,bankDenom:s.network.bankDenom,quantumWei:s.network.quantumWei.toString()},
      walletChain:s.publicRpcUrl ? {chainId:toHex(s.network.chainId),chainName:`HumanDock ${s.network.network}`,nativeCurrency:{name:s.network.nativeSymbol,symbol:s.network.nativeSymbol,decimals:18},rpcUrls:[s.publicRpcUrl]} : undefined,
      contracts:{escrow:s.deployment.escrow,registry:s.deployment.registry},confirmations:s.deployment.confirmations,localTest:s.network.network === 'local', verifiedAt:this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      sync:{state:this.syncFault ? 'blocked' : this.syncJob ? 'syncing' : 'idle'}, fees:{reviewerWei:s.reviewerFeeWei.toString(),platformWei:s.platformFeeWei.toString()} };
  }
  async ensureReady() {
    requireThat(this.settings, 'ME_CONFIGURATION_REQUIRED', this.configurationError, 503);
    if (this.deploymentReport && this.now() - this.checkedAt < 15_000) return;
    if (!this.verification) this.verification = (async () => {
      try { this.deploymentReport = await verifyDeployment(this.settings!.client,this.settings!.network,this.settings!.deployment); this.checkedAt = this.now(); }
      catch (e) { this.deploymentReport = undefined; throw new DomainError(e instanceof MeChainError ? e.code : 'CHAIN_UNAVAILABLE','The configured chain/deployment could not be verified.',503); }
    })().finally(() => { this.verification = undefined; });
    await this.verification;
  }
  private hmac(label: string, value: string) { return createHmac('sha256',this.settings!.identitySecret).update(`${label}:${value}`).digest('hex'); }
  private identityCacheId(wallet:string) {return `${this.cursorId()}:${wallet.toLowerCase()}`;}
  async refreshIdentity(user: User): Promise<User> {
    requireThat(this.settings, 'ME_CONFIGURATION_REQUIRED', this.configurationError, 503);
    const wallet = getAddress(user.wallet);
    let evidence: IdentityEvidence;
    try { evidence = await this.settings.identityVerifier(wallet); }
    catch (e) {
      const rejected = e instanceof Error && e.name === 'MeIdentityRejectedError';
      user.identity = {status:rejected ? 'rejected' : 'unavailable',label:rejected ? 'The wallet does not meet the configured ME identity policy.' : 'ME identity could not be checked. Retry when the identity service is available.'};
      await this.db.query('DELETE FROM hd_live_identities WHERE wallet=$1',[this.identityCacheId(wallet)]);
      return user;
    }
    requireThat(same(evidence.wallet,wallet) && (!evidence.localTest || this.settings.network.network === 'local'), 'IDENTITY_SOURCE_INVALID','A local fixture cannot certify a ME account.',403);
    const localTest = evidence.localTest === true;
    requireThat(this.settings.network.network !== 'local' || localTest, 'IDENTITY_SOURCE_INVALID','Local development identity evidence must be explicitly labelled.',403);
    const canonicalKey = this.hmac('identity',evidence.canonicalDid), orgId = `me-org:${this.hmac('organization',evidence.canonicalDid)}`;
    const record: IdentityCache = {canonicalKey,orgId,wallet,kycLevel:evidence.kycLevel,checkedAt:new Date(this.now()).toISOString(),policyReference:evidence.policyReference,localTest};
    await this.db.query('INSERT INTO hd_live_identities(wallet,data,checked_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(wallet) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at',[this.identityCacheId(wallet),json(record),record.checkedAt]);
    user.orgId = orgId;
    user.identity = {status:localTest ? 'local_test' : 'verified',label:localTest ? 'Local chain identity fixture — not ME certification' : 'ME wallet binding and configured identity policy verified',checkedAt:record.checkedAt,kycLevel:record.kycLevel,policyReference:record.policyReference};
    return user;
  }
  async admit(user: User) {
    await this.ensureReady();
    const config = this.config();
    requireThat(config.admissionsEnabled,'ME_ADMISSIONS_BLOCKED',config.admissionReasons.join(' ') || config.reasons.join(' '),503);
    await this.refreshIdentity(user);
    requireThat(['verified','local_test'].includes(user.identity.status),'ME_IDENTITY_REQUIRED',user.identity.label,403);
  }
  private async identity(sql: Sql, wallet: string): Promise<IdentityCache> {
    const row = (await sql.query<{data:IdentityCache}>('SELECT data FROM hd_live_identities WHERE wallet=$1',[this.identityCacheId(wallet)])).rows[0];
    requireThat(row && this.now()-Date.parse(row.data.checkedAt)<5*60_000,'ME_IDENTITY_STALE','Refresh the wallet identity before a new admission.',403);
    return row.data;
  }
  matches(task: PrivateTask) { return !!this.settings && !!task.chain && task.executionMode === 'me' && task.chain.chainId === this.settings.network.chainId && same(task.chain.escrow,this.settings.deployment.escrow) && same(task.chain.registry,this.settings.deployment.registry); }
  async task(sql: Sql, id: string, user: User) {
    const row = (await sql.query<{data:PrivateTask}>('SELECT data FROM hd_tasks WHERE id=$1 AND (org_id=$2 OR reviewer_id=$3 OR buyer_id=$3)',[id,user.orgId,user.id])).rows[0];
    requireThat(row && this.matches(row.data),'NOT_FOUND','Task not found on this network.',404); domain.assertRead(row.data,user); return row.data;
  }
  private async meta(sql: Sql, id: string) { const row=(await sql.query<{data:TaskMeta}>('SELECT data FROM hd_live_tasks WHERE task_id=$1',[id])).rows[0]; requireThat(row,'CHAIN_METADATA_MISSING','Task chain metadata is missing.',503); return row.data; }
  private async saveTask(sql: Sql, task: PrivateTask) { await sql.query('UPDATE hd_tasks SET data=$2::jsonb,version=$3,org_id=$4 WHERE id=$1',[task.id,json(task),task.version,task.orgId]); }
  private async saveMeta(sql: Sql, id: string, meta: TaskMeta) { await sql.query('UPDATE hd_live_tasks SET data=$2::jsonb WHERE task_id=$1',[id,json(meta)]); }
  async createTask(sql: Sql, user: User, input: Parameters<typeof domain.createTask>[1], reviewerWallet: Address) {
    const s=this.settings!; requireThat(s.reviewers.some(a=>same(a,reviewerWallet)),'REVIEWER_NOT_INVITED','Select an invited reviewer.',400);
    const buyerIdentity = await this.identity(sql,user.wallet);
    const task = domain.createTask(user,input,this.now(),{executionMode:'me',reviewerId:walletUserId(reviewerWallet)});
    task.chain={chainId:s.network.chainId,escrow:s.deployment.escrow,registry:s.deployment.registry};
    const meta: TaskMeta={baseline:structuredClone(task),reviewerWallet:getAddress(reviewerWallet),clientRequestId:textHash(`HumanDock/request/${task.id}`),buyerPrincipal:`0x${this.hmac('task-principal',`${task.id}:${buyerIdentity.canonicalKey}`)}`,identityKeyId:this.hmac('identity-key-id','HumanDock v1')};
    await sql.query('INSERT INTO hd_tasks(id,org_id,buyer_id,reviewer_id,version,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[task.id,task.orgId,task.buyerId,task.reviewerId,task.version,json(task)]);
    await sql.query('INSERT INTO hd_live_tasks(task_id,data) VALUES($1,$2::jsonb)',[task.id,json(meta)]);
    return task;
  }
  async quoteTask(sql: Sql, task: PrivateTask, user: User) {
    domain.assertBuyer(task,user); requireThat(task.status==='DRAFT' && !task.quote,'QUOTE_ALREADY_FROZEN','A task has one immutable quote.');
    const s=this.settings!, meta=await this.meta(sql,task.id), block=await s.client.getBlock();
    requireThat(s.signers.quote,'QUOTE_SIGNER_REQUIRED','The quote issuer is not configured.',503);
    task.sourceCommitment=commitment('SOURCE',task.secrets.sourceManifest,task.secrets.sourceSalt);
    const q:Quote={buyer:getAddress(user.wallet),clientRequestId:meta.clientRequestId,taskCommitment:task.sourceCommitment as Hex,buyerPrincipal:meta.buyerPrincipal,reviewerFeeWei:s.reviewerFeeWei,platformFeeWei:s.platformFeeWei,quantumWei:s.network.quantumWei,acceptUntil:block.timestamp+86400n,reviewDuration:86400,expiresAt:block.timestamp+300n,nonce:nonce()};
    requireThat(q.reviewerFeeWei+q.platformFeeWei<=this.deploymentReport!.maxTaskFeeWei,'QUOTE_OVER_CAP','Configured fees exceed the contract cap.',400);
    meta.quote=wire(q); meta.quoteSignature=await s.signers.quote.signTypedData(quoteTypedData(s.network.chainId,s.deployment.escrow,q)); meta.termsHash=hashTypedData(quoteTypedData(s.network.chainId,s.deployment.escrow,q));
    task.quote={id:randomUUID(),reviewerAtoms:q.reviewerFeeWei.toString(),platformAtoms:q.platformFeeWei.toString(),totalAtoms:(q.reviewerFeeWei+q.platformFeeWei).toString(),quantumAtoms:q.quantumWei.toString(),currency:s.network.nativeSymbol,expiresAt:iso(q.expiresAt),acceptUntil:iso(q.acceptUntil)};
    domain.record(task,user,'QUOTED','Signed quote frozen; no funds have moved',this.now()); meta.baseline=structuredClone(task);
    await this.saveTask(sql,task); await this.saveMeta(sql,task.id,meta); return task;
  }
  async changedVersion(sql: Sql, task: PrivateTask, user: User, text: string) { domain.addVersion(task,user,text,this.now()); const meta=await this.meta(sql,task.id); meta.displayVersionId=task.currentVersionId; await this.saveTask(sql,task); await this.saveMeta(sql,task.id,meta); }

  private transaction(account: Address, target: 'escrow'|'registry', functionName: string, args: readonly unknown[], value=0n): PreparedTransaction {
    const s=this.settings!; return {chainId:s.network.chainId,from:account,to:s.deployment[target],data:encodeFunctionData({abi:(target==='escrow'?reviewEscrowAbi:releaseRegistryAbi) as Abi,functionName,args}),value:toHex(value)};
  }
  async prepare(sql: Sql, user: User, action: ChainAction, taskId: string | undefined, expectedVersion: number | undefined, payload: Record<string,unknown> = {}): Promise<ChainIntent> {
    const s=this.settings!; requireThat(this.config().writesEnabled,'CHAIN_NOT_READY','Canonical chain synchronization must be healthy before preparing transactions.',503);
    const task=taskId ? await this.task(sql,taskId,user) : undefined;
    requireThat(action==='withdraw' ? !taskId : task,'TASK_REQUIRED','This action requires a task.',400);
    if(task) domain.expected(task,expectedVersion!);
    const active=(await sql.query<{data:StoredIntent}>("SELECT data FROM hd_me_intents WHERE actor_id=$1 AND task_id IS NOT DISTINCT FROM $2 AND state IN ('awaiting_signature','ready','broadcast','confirming') ORDER BY created_at DESC",[user.id,taskId??null])).rows.map(r=>r.data).filter(i=>i.view.chainId===s.network.chainId && i.view.allowedTargets.some(a=>same(a,s.deployment.escrow)) && i.view.allowedTargets.some(a=>same(a,s.deployment.registry)));
    requireThat(!active.some(i=>i.view.txHash || Date.parse(i.view.expiresAt)>this.now()),'INTENT_PENDING','Resume or reconcile the existing transaction intent before creating another.');
    const block=await s.client.getBlock(), stamp=Number(block.timestamp)*1000, account=getAddress(user.wallet);
    const meta=task ? await this.meta(sql,task.id) : undefined;
    if(action==='fund' || action==='accept-assignment')requireThat(meta?.identityKeyId===this.hmac('identity-key-id','HumanDock v1'),'IDENTITY_KEY_CHANGED','Restore the identity key used for this order before issuing a new admission. Existing exits remain available.',503);
    const view:ChainIntent={id:randomUUID(),taskId:taskId??null,action,account,chainId:s.network.chainId,status:'ready',allowedTargets:[s.deployment.escrow,s.deployment.registry],summary:{title:action,description:action,amountWei:'0',symbol:s.network.nativeSymbol},expiresAt:new Date(this.now()+15*60_000).toISOString(),confirmations:0,requiredConfirmations:s.deployment.confirmations,applied:false};
    const record:StoredIntent={view,private:{expectedEvent:''}};
    const chainTaskId=meta?.chainTaskId ? BigInt(meta.chainTaskId) : undefined;
    const candidate=task ? structuredClone(task) : undefined;
    const setCall=(name:string,args:readonly unknown[],event:string,value=0n,target:'escrow'|'registry'='escrow')=>{view.transaction=this.transaction(account,target,name,args,value); view.summary.amountWei=value.toString(); record.private.expectedEvent=event;};
    if(action==='fund') {
      domain.assertBuyer(task!,user); requireThat(task!.status==='DRAFT' && meta!.quote && meta!.quoteSignature,'QUOTE_REQUIRED','Freeze a signed quote before funding.');
      const q=restoredQuote(meta!.quote); requireThat(block.timestamp<q.expiresAt,'QUOTE_EXPIRED','This immutable quote has expired. Create a new task.');
      const identity=await this.identity(sql,user.wallet); requireThat(meta!.buyerPrincipal===`0x${this.hmac('task-principal',`${task!.id}:${identity.canonicalKey}`)}`,'IDENTITY_CHANGED','Buyer identity no longer matches the signed quote.',403);
      setCall('createAndFund',[q,meta!.quoteSignature],'TaskFunded',q.reviewerFeeWei+q.platformFeeWei);
      view.expiresAt=iso(q.expiresAt); view.summary.description='Fund the signed reviewer fee and platform fee in native coin.';
    } else if(action==='accept-assignment') {
      requireThat(chainTaskId && s.signers.assignment,'ASSIGNMENT_NOT_READY','Confirmed funding and an assignment issuer are required.');
      domain.acceptAssignment(candidate!,user,stamp); const identity=await this.identity(sql,user.wallet);
      const reviewerPrincipal=`0x${this.hmac('task-principal',`${task!.id}:${identity.canonicalKey}`)}` as Hex;
      requireThat(reviewerPrincipal!==meta!.buyerPrincipal,'SELF_REVIEW_FORBIDDEN','Two wallets of the same canonical identity cannot review one another.',403);
      const acceptanceEnd=BigInt(Math.floor(Date.parse(task!.quote!.acceptUntil)/1000));
      const permit={taskId:chainTaskId,taskCommitment:task!.sourceCommitment as Hex,termsHash:meta!.termsHash!,buyer:restoredQuote(meta!.quote).buyer,reviewer:account,reviewerPrincipal,expiresAt:acceptanceEnd<block.timestamp+300n?acceptanceEnd:block.timestamp+300n,nonce:nonce()};
      const sig=await s.signers.assignment.signTypedData(assignmentTypedData(s.network.chainId,s.deployment.escrow,permit)); setCall('acceptAssignment',[permit,sig],'TaskAssigned');
      view.expiresAt=iso(permit.expiresAt);view.summary.description='Accept the named assignment; the on-chain delivery deadline starts when confirmed.';
    } else if(action==='reviews') {
      requireThat(chainTaskId && s.signers.delivery,'DELIVERY_NOT_READY','A confirmed assignment and delivery gate are required.');
      requireThat(this.deploymentReport && same(s.signers.delivery.address,this.deploymentReport.roles.deliveryGate),'DELIVERY_GATE_MISMATCH','The delivery attestation key does not match this deployment.',503);
      domain.submitReview(candidate!,user,reviewInput.parse(payload),stamp);
      const envelope:DeliveryEnvelope={taskId:chainTaskId,taskCommitment:task!.sourceCommitment as Hex,deliveryCommitment:candidate!.report!.deliveryCommitment as Hex,reviewer:account,verdict:Verdict[candidate!.report!.verdict],schemaHash:DELIVERY_SCHEMA_HASH,issuedAt:block.timestamp,expiresAt:block.timestamp+600n,nonce:nonce()};
      const typed=deliveryTypedData(s.network.chainId,s.deployment.escrow,envelope);
      record.private={candidate,typedData:wire(typed),gateSignature:await s.signers.delivery.signTypedData(typed),expectedEvent:'DeliverySubmitted'};
      view.status='awaiting_signature'; view.typedData=wire(typed); view.expiresAt=iso(envelope.expiresAt);
      view.summary={...view.summary,description:`Seal the exact ${candidate!.report!.verdict} report and reviewed version.`,versionId:candidate!.report!.reviewedVersionId,deliveryCommitment:envelope.deliveryCommitment};
    } else if(action==='approvals') {
      requireThat(chainTaskId,'FUNDING_NOT_CONFIRMED','Funding is not confirmed.');
      const p=z.object({versionId:z.uuid(),expiresInHours:z.union([z.literal(24),z.literal(72),z.literal(168)])}).parse(payload);
      domain.approveTask(candidate!,user,p.versionId,p.expiresInHours,stamp);
      const a:ApprovalIntent={escrow:s.deployment.escrow,taskId:chainTaskId,brandAuthority:account,deliveryCommitment:task!.report!.deliveryCommitment as Hex,purposeHash:EXPORT_PURPOSE_HASH,expiresAt:BigInt(Math.floor(Date.parse(candidate!.approval!.expiresAt)/1000)),nonce:nonce()};
      const typed=approvalTypedData(s.network.chainId,s.deployment.registry,a);
      record.private={candidate,typedData:wire(typed),chainApprovalId:hashTypedData(typed),expectedEvent:'ReleaseApproved'};
      view.status='awaiting_signature';view.typedData=wire(typed);view.summary={...view.summary,description:'Approve this exact PASS version for controlled export. This does not settle the service.',versionId:p.versionId,deliveryCommitment:a.deliveryCommitment};
    } else if(action==='revoke') {
      domain.revokeTask(candidate!,user,stamp); requireThat(meta!.approvalChainId,'APPROVAL_NOT_CONFIRMED','There is no indexed chain approval.');
      const r:RevocationIntent={approvalId:meta!.approvalChainId!,brandAuthority:account,expiresAt:block.timestamp+600n,nonce:nonce()},typed=revocationTypedData(s.network.chainId,s.deployment.registry,r);
      record.private={candidate,typedData:wire(typed),expectedEvent:'ReleaseRevoked'};view.status='awaiting_signature';view.typedData=wire(typed);view.expiresAt=iso(r.expiresAt);view.summary.description='Revoke further exports covered by this chain approval.';
    } else if(action==='accept-service') {
      domain.acceptService(candidate!,user,stamp);setCall('acceptService',[chainTaskId!],'TaskClosed');view.summary.description='Allocate reviewer compensation and platform fee. Allocation is separate from withdrawal and content approval.';
    } else if(action==='cancel') {
      domain.cancelTask(candidate!,user,stamp);setCall('cancelUnassigned',[chainTaskId!],'TaskClosed');view.summary.description='Cancel before assignment and allocate a full refund to your claimable balance.';
    } else if(action==='disputes') {
      const reason=z.string().trim().min(10).max(2000).parse(payload.reason);domain.openDispute(candidate!,user,reason,stamp);
      const evidence=commitment('FINAL',{schema:'dispute.v1',taskId:task!.id,reasonHash:textHash(reason)},randomSalt());
      record.private.candidate=candidate;setCall('openDispute',[chainTaskId!,evidence],'DisputeOpened');view.summary.description='Open a service dispute within the on-chain challenge window.';
    } else if(action==='timeouts') {
      domain.timeoutTask(candidate!,user,stamp); const fn=task!.status==='FUNDED'?'expireUnassigned':task!.status==='ASSIGNED'?'expireUndelivered':task!.status==='DISPUTED'?'finalizeDisputeTimeout':'settleAfterWindow';
      setCall(fn,[chainTaskId!],'TaskClosed');view.summary.description='Execute the timeout exit permitted by the current on-chain deadline.';
    } else if(action==='withdraw') {
      requireThat(payload.receiver===undefined || (typeof payload.receiver==='string' && same(payload.receiver,account)),'WITHDRAWAL_RECEIVER_MISMATCH','This MVP withdraws only to the signed-in wallet.',400);
      const claimable=await s.client.readContract({address:s.deployment.escrow,abi:reviewEscrowAbi,functionName:'claimableWei',args:[account]});
      requireThat(claimable>0n,'NO_CLAIMABLE_BALANCE','There are no allocated funds to withdraw.');
      setCall('withdrawTo',[account],'Withdrawal'); view.summary={...view.summary,description:'Withdraw all currently allocated native coin to this signed-in wallet. Gas is separate.',receiver:account,withdrawalAmountWei:claimable.toString()};
    }
    if(view.transaction) await this.simulate(view.transaction);
    await sql.query('INSERT INTO hd_me_intents(id,actor_id,task_id,action,state,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[view.id,user.id,view.taskId,action,view.status,json(record)]);
    return view;
  }
  private async simulate(tx:PreparedTransaction) { try { await this.settings!.client.call({account:tx.from,to:tx.to,data:tx.data,value:BigInt(tx.value)}); } catch { throw new DomainError('TRANSACTION_SIMULATION_FAILED','The contract currently rejects this action. Refresh chain state, balance and deadlines.'); } }
  async intent(sql:Sql,id:string,user:User) { const row=(await sql.query<{data:StoredIntent}>('SELECT data FROM hd_me_intents WHERE id=$1 AND actor_id=$2',[id,user.id])).rows[0]; requireThat(row && row.data.view.chainId===this.settings?.network.chainId && row.data.view.allowedTargets.some(a=>same(a,this.settings!.deployment.escrow)) && row.data.view.allowedTargets.some(a=>same(a,this.settings!.deployment.registry)),'NOT_FOUND','Transaction intent not found on this deployment.',404);return row.data; }
  private async saveIntent(sql:Sql,record:StoredIntent) { await sql.query('UPDATE hd_me_intents SET state=$2,data=$3::jsonb WHERE id=$1',[record.view.id,record.view.status,json(record)]); }
  async listIntents(user:User) { return (await this.db.query<{data:StoredIntent}>('SELECT data FROM hd_me_intents WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 50',[user.id])).rows.map(r=>r.data.view).filter(i=>i.chainId===this.settings?.network.chainId && i.allowedTargets.some(a=>same(a,this.settings!.deployment.escrow))); }
  async attachSignature(sql:Sql,user:User,id:string,signature:Hex) {
    requireThat(this.config().writesEnabled,'CHAIN_NOT_READY','Canonical synchronization is required before signing an action.',503);
    const record=await this.intent(sql,id,user),v=record.view,t=record.private.typedData;
    requireThat(v.status==='awaiting_signature' && t && this.now()<Date.parse(v.expiresAt),'INTENT_NOT_SIGNABLE','This signature request is no longer active.');
    let signer:Address;try{signer=await recoverTypedDataAddress({...t,signature});}catch{throw new DomainError('SIGNATURE_INVALID','Invalid typed signature.',400);}
    requireThat(same(signer,v.account),'SIGNATURE_INVALID','The typed signature belongs to another wallet.',403);
    if(v.action==='reviews') v.transaction=this.transaction(v.account,'escrow','submitDelivery',[t.message,signature,record.private.gateSignature]);
    else if(v.action==='approvals') v.transaction=this.transaction(v.account,'registry','approve',[t.message,signature]);
    else if(v.action==='revoke') v.transaction=this.transaction(v.account,'registry','revoke',[t.message,signature]);
    else throw new DomainError('SIGNATURE_NOT_REQUIRED','This action does not accept a user typed signature.',400);
    await this.simulate(v.transaction);v.status='ready';await this.saveIntent(sql,record);return v;
  }
  async broadcast(sql:Sql,user:User,id:string,hash:Hex) {
    const r=await this.intent(sql,id,user);requireThat(r.view.transaction,'TRANSACTION_NOT_READY','Complete the signature step first.');
    requireThat(['ready','broadcast','confirming','confirmed','rejected','expired','reorged','reverted'].includes(r.view.status),'INTENT_NOT_BROADCASTABLE','This intent cannot register a broadcast.');
    const replacing=r.view.txHash && !same(r.view.txHash,hash),oldHash=r.view.txHash;
    const observed=await this.observedTransaction(hash);
    if(replacing && r.view.status!=='rejected') {
      if(r.private.broadcastNonce===undefined && oldHash) {const original=await this.observedTransaction(oldHash);if(original && this.exactTransaction(original,r.view.transaction))r.private.broadcastNonce=original.nonce;}
      requireThat(observed && r.private.broadcastNonce!==undefined && same(observed.from,r.view.account) && observed.nonce===r.private.broadcastNonce,'REPLACEMENT_UNVERIFIED','A replacement must be observable on this chain and consume the original signed-in wallet nonce. The original nonce cannot be guessed.',409);
      if(!this.exactTransaction(observed,r.view.transaction)) {
        requireThat(await this.confirmedNonceConsumption(hash),'REPLACEMENT_UNCONFIRMED','Wait for the cancellation or other nonce-consuming transaction to reach confirmation depth.',409);
        r.private.cancellationHash=hash;r.private.previousHashes??=[];r.private.previousHashes.push(oldHash!);
        r.view.status='replaced';r.view.applied=false;r.view.error={code:'TRANSACTION_REPLACED',message:'The original nonce was confirmed by a different transaction. No intent effect is claimed.'};await this.saveIntent(sql,r);return r.view;
      }
    }
    if(observed) {
      requireThat(this.exactTransaction(observed,r.view.transaction),'INTENT_MISMATCH','This transaction does not match the signed-in wallet, contract, amount and exact calldata.',400);
      r.private.broadcastNonce=observed.nonce;
    }
    if(replacing){r.private.previousHashes??=[];r.private.previousHashes.push(oldHash!);}
    r.view.txHash=hash;
    if(r.view.status!=='confirmed' || replacing){r.view.status='broadcast';r.view.applied=false;delete r.view.error;}
    // A client-supplied hash never reserves another actor's transaction or proves payment.
    await this.saveIntent(sql,r);return r.view;
  }
  private async observedTransaction(hash:Hex) {
    const s=this.settings!;requireThat(await s.client.getChainId()===s.network.chainId,'CHAIN_MISMATCH','The RPC is on another network.',503);
    try {const tx=await s.client.getTransaction({hash});requireThat(tx.chainId===undefined || tx.chainId===s.network.chainId,'CHAIN_MISMATCH','The signed transaction belongs to another network.',400);return tx;}
    catch(error){if(error instanceof TransactionNotFoundError)return null;throw error;}
  }
  private exactTransaction(tx:{from:string;to:string|null;input:string;value:bigint},expected:PreparedTransaction) {return !!tx.to && same(tx.from,expected.from) && same(tx.to,expected.to) && same(tx.input,expected.data) && tx.value===BigInt(expected.value);}
  private async confirmedNonceConsumption(hash:Hex) {
    const s=this.settings!;
    try {const receipt=await s.client.getTransactionReceipt({hash});const [block,head]=await Promise.all([s.client.getBlock({blockNumber:receipt.blockNumber}),s.client.getBlockNumber({cacheTime:0})]);return same(block.hash,receipt.blockHash) && head-receipt.blockNumber+1n>=BigInt(s.deployment.confirmations);}
    catch(error){if(error instanceof TransactionReceiptNotFoundError)return false;throw error;}
  }

  async reconcile(user:User,id:string) {
    await this.ensureReady();
    let record=await this.intent(this.db,id,user),view=record.view;
    if(record.private.cancellationHash) {
      if(!await this.confirmedNonceConsumption(record.private.cancellationHash)){view.status='reorged';view.applied=false;this.syncFault='A recorded replacement is no longer confirmed. Recheck canonical chain state before retrying.';await this.db.query("UPDATE hd_chain_cursors SET state='reorg' WHERE id=$1",[this.cursorId()]);await this.db.transaction(sql=>this.saveIntent(sql,record));}
      return {intent:view};
    }
    if(!view.txHash) {
      if(this.now()>=Date.parse(view.expiresAt) && ['ready','awaiting_signature'].includes(view.status)) {view.status='expired';await this.db.transaction(sql=>this.saveIntent(sql,record));}
      return {intent:view};
    }
    requireThat(view.transaction,'TRANSACTION_NOT_READY','No exact transaction is associated with this intent.');
    let receipt;
    try { receipt=await verifyTransaction(this.settings!.client,view.transaction,view.txHash,this.settings!.deployment.confirmations); }
    catch(e) {
      const code=e instanceof MeChainError?e.code:'RPC_UNAVAILABLE';
      view.error={code,message:code==='INTENT_MISMATCH'?'This hash does not match the signed-in account, contract, amount and exact calldata.':'The transaction cannot currently be verified. Retry verification; do not send it again.'};
      view.applied=false;
      if(code==='INTENT_MISMATCH')view.status='rejected';
      if(code==='REORG'){view.status='reorged';this.syncFault='A chain reorganization requires projection replay.';await this.db.query("UPDATE hd_chain_cursors SET state='reorg' WHERE id=$1",[this.cursorId()]);}
      await this.db.transaction(sql=>this.saveIntent(sql,record));return {intent:view};
    }
    delete view.error;
    if(receipt.status==='pending') {view.status='broadcast';view.applied=false;}
    else {
      view.status=receipt.status; view.confirmations=Number(receipt.confirmations);if(receipt.status!=='confirmed')view.applied=false;
      view.block={number:receipt.blockNumber.toString(),hash:receipt.blockHash,timestamp:iso(receipt.blockTimestamp)};
      if(receipt.status==='confirmed') requireThat(receipt.events.some(e=>e.eventName===record.private.expectedEvent),'EXPECTED_EVENT_MISSING','A successful receipt did not contain the required contract event.',503);
    }
    await this.db.transaction(sql=>this.saveIntent(sql,record));
    if(receipt.status==='confirmed') {
      await this.sync();
      record=await this.intent(this.db,id,user);view=record.view;
      const ids=receipt.events.filter(e=>e.eventName===record.private.expectedEvent).map(e=>e.id);
      const persisted=await Promise.all(ids.map(eventId=>this.db.query('SELECT id FROM hd_chain_events WHERE id=$1',[eventId])));
      view.applied=persisted.every(r=>r.rows.length>0);
      if(view.applied && view.action==='withdraw') {
        try {view.reconciliation=await this.withdrawalReconciliation(receipt);}
        catch(error) {
          if(!(error instanceof MeChainError) || error.code!=='REORG')throw error;
          view.status='reorged';view.applied=false;view.error={code:'REORG',message:'The withdrawal receipt became noncanonical during balance reconciliation. Replay is required.'};delete view.reconciliation;
          this.syncFault='A chain reorganization requires projection replay.';
          await this.db.query("UPDATE hd_chain_cursors SET state='reorg' WHERE id=$1",[this.cursorId()]);
        }
      }
      await this.db.transaction(sql=>this.saveIntent(sql,record));
    }
    const task=view.taskId ? publicTask(await this.task(this.db,view.taskId,user)) : undefined;
    return {intent:view,task};
  }
  private async withdrawalReconciliation(receipt:MinedTransactionVerification):Promise<Record<string,unknown>> {
    const s=this.settings!,event=receipt.events.find(e=>e.eventName==='Withdrawal');
    if(!event || receipt.blockNumber===0n) return {status:'unverified',reason:'No matching withdrawal event or parent block.'};
    const gasCharging=s.gasCharging ?? (s.network.network==='local'?'exact-wei':undefined);
    if(!gasCharging) return {status:'unverified',reason:'A verified ME gas charging model is not configured.',transactionHash:receipt.hash,transferredWei:String(event.args.amountWei)};
    try {
      const addresses=[...new Set([receipt.from,receipt.to,String(event.args.receiver)].map(a=>a.toLowerCase()))].map(a=>getAddress(a));
      const bankReader=s.network.network!=='local'&&s.network.cosmosRestUrl?createCosmosBankReader(s.network):undefined;
      const [before,after]=await Promise.all([
        Promise.all(addresses.map(address=>readBalanceSnapshot(s.client,{address,quantumWei:s.network.quantumWei,blockNumber:receipt.blockNumber-1n,bankReader}))),
        Promise.all(addresses.map(address=>readBalanceSnapshot(s.client,{address,quantumWei:s.network.quantumWei,blockNumber:receipt.blockNumber,bankReader}))),
      ]);
      if(after.some(snapshot=>!same(snapshot.blockHash,receipt.blockHash)) || after.some(snapshot=>before.some(parent=>same(snapshot.address,parent.address) && !same(snapshot.parentHash,parent.blockHash))))throw new MeChainError('REORG','Withdrawal snapshots no longer match the verified receipt fork.');
      const result=reconcileWithdrawal({before,after,receipt,withdrawal:event,quantumWei:s.network.quantumWei,gasCharging});
      return wire({...result,executionEnvironment:s.network.network,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,before,after});
    } catch(error) { if(error instanceof MeChainError && error.code==='REORG')throw error;return {status:'unverified',reason:'Historical balances or bank evidence could not be read. The confirmed withdrawal remains recorded.',transactionHash:receipt.hash,transferredWei:String(event.args.amountWei)}; }
  }
  private cursorId() { const s=this.settings!;return `${s.network.chainId}:${s.deployment.escrow.toLowerCase()}:${s.deployment.registry.toLowerCase()}`; }
  async sync() {
    if(this.stopped || !this.settings) return;
    if(this.syncJob) return this.syncJob;
    this.syncJob=this.runSync().finally(()=>{this.syncJob=undefined;});
    return this.syncJob;
  }
  private async runSync() {
    await this.ensureReady();const s=this.settings!,key=this.cursorId();
    try {
      await this.db.query("INSERT INTO hd_chain_cursors(id,next_block,last_hash,state) VALUES($1,$2,NULL,'healthy') ON CONFLICT(id) DO NOTHING",[key,s.deployment.fromBlock.toString()]);
      let cursor=(await this.db.query<{next_block:string;last_hash:string|null;state:string}>('SELECT * FROM hd_chain_cursors WHERE id=$1',[key])).rows[0];
      requireThat(cursor.state==='healthy','CHAIN_REPLAY_REQUIRED','Chain projections require operator replay before continuing.',503);
      const from=BigInt(cursor.next_block);
      if(cursor.last_hash && from>s.deployment.fromBlock) {
        const previous=await s.client.getBlock({blockNumber:from-1n});
        if(!same(previous.hash,cursor.last_hash)) {
          await this.db.query("UPDATE hd_chain_cursors SET state='reorg' WHERE id=$1",[key]);
          throw new MeChainError('REORG','A persisted chain checkpoint has changed.');
        }
      }
      const latest=await s.client.getBlockNumber({cacheTime:0}),confirmed=latest-BigInt(s.deployment.confirmations)+1n;
      if(confirmed<from){this.syncFault=undefined;this.synchronized=true;return;}
      const to=confirmed>from+999n?from+999n:confirmed;
      const events=await scanContractEvents(s.client,s.deployment,from,to,{chunkSize:250n});
      const numbers=[...new Set(events.map(e=>e.blockNumber.toString()).concat(to.toString()))];
      const blocks=await Promise.all(numbers.map(n=>s.client.getBlock({blockNumber:BigInt(n)})));
      const times=new Map(blocks.map(b=>[b.number.toString(),b.timestamp]));
      for(const event of events) requireThat(blocks.some(b=>b.number===event.blockNumber && same(b.hash,event.blockHash)),'CHAIN_REORG','Event block changed before projection.',503);
      const tip=blocks.find(b=>b.number===to)!;
      // A fork can begin at the old checkpoint while logs are being fetched. Checking
      // only the new tip would splice two forks together and permanently hide it.
      const tipAgain=await s.client.getBlock({blockNumber:to});
      if(!same(tipAgain.hash,tip.hash))throw new MeChainError('REORG','The scanned tip changed before projection.');
      if(cursor.last_hash && from>s.deployment.fromBlock) {
        const [previousAgain,boundary]=await Promise.all([s.client.getBlock({blockNumber:from-1n}),s.client.getBlock({blockNumber:from})]);
        if(!same(previousAgain.hash,cursor.last_hash) || !same(boundary.parentHash,cursor.last_hash))throw new MeChainError('REORG','The scanned range no longer extends the persisted canonical checkpoint.');
      }
      await this.db.transaction(async sql=>{
        const current=(await sql.query<{next_block:string;state:string}>('SELECT next_block,state FROM hd_chain_cursors WHERE id=$1',[key])).rows[0];
        requireThat(current.next_block===cursor.next_block && current.state==='healthy','INDEXER_CONFLICT','Another indexer advanced the checkpoint. Retry.',409);
        for(const event of events) {
          const inserted=await sql.query('INSERT INTO hd_chain_events(id,chain_id,contract,block_number,block_hash,tx_hash,log_index,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id',[event.id,event.chainId,event.address.toLowerCase(),event.blockNumber.toString(),event.blockHash,event.transactionHash,event.logIndex,json(event)]);
          if(inserted.rows.length) await this.project(sql,event,times.get(event.blockNumber.toString())!);
        }
        await sql.query('UPDATE hd_chain_cursors SET next_block=$2,last_hash=$3 WHERE id=$1',[key,(to+1n).toString(),tip.hash]);
      });
      this.syncFault=undefined;this.synchronized=to===confirmed;
    } catch(e) {
      if((e instanceof MeChainError && e.code==='REORG') || (e instanceof DomainError && e.code==='CHAIN_REORG')) {await this.db.query("UPDATE hd_chain_cursors SET state='reorg' WHERE id=$1",[key]);this.syncFault='A chain reorganization was detected. New writes and exports are blocked until canonical replay.';}
      else if(e instanceof DomainError && e.code==='CHAIN_REPLAY_REQUIRED') this.syncFault=e.message;
      else this.syncFault='Event synchronization is unavailable; retry before preparing another transaction.';
      throw e;
    }
  }
  private async project(sql:Sql,event:DecodedContractEvent,time:bigint) {
    const s=this.settings!,a=event.args,at=iso(time);
    const entry=async(taskId:string|null,wallet:string,bucket:string,amount:bigint,slot:string)=>{
      if(amount===0n)return;
      await sql.query('INSERT INTO hd_me_ledger(id,event_id,task_id,account_id,bucket,amount_wei,tx_hash,block_number,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[`${event.id}:${slot}`,event.id,taskId,walletUserId(wallet),bucket,amount.toString(),event.transactionHash,event.blockNumber.toString(),at]);
    };
    if(event.eventName==='Withdrawal') {
      await entry(null,String(a.beneficiary),'claimable',-BigInt(String(a.amountWei)),'debit');
      await entry(null,String(a.beneficiary),'withdrawn',BigInt(String(a.amountWei)),'withdrawn');
    }
    let found:{task_id:string;data:TaskMeta}|undefined;
    if(event.eventName==='TaskFunded') found=(await sql.query<{task_id:string;data:TaskMeta}>("SELECT task_id,data FROM hd_live_tasks WHERE data->>'clientRequestId'=$1",[String(a.clientRequestId)])).rows[0];
    else if(a.taskId!==undefined) found=(await sql.query<{task_id:string;data:TaskMeta}>("SELECT task_id,data FROM hd_live_tasks WHERE data->>'chainTaskId'=$1 AND data->'baseline'->'chain'->>'escrow'=$2",[String(a.taskId),s.deployment.escrow])).rows[0];
    else if(event.eventName==='ReleaseRevoked') found=(await sql.query<{task_id:string;data:TaskMeta}>("SELECT task_id,data FROM hd_live_tasks WHERE data->>'approvalChainId'=$1",[String(a.approvalId)])).rows[0];
    if(found) {
      const task=(await sql.query<{data:PrivateTask}>('SELECT data FROM hd_tasks WHERE id=$1',[found.task_id])).rows[0].data,meta=found.data;
      if(!this.matches(task))return;
      const proposals=(await sql.query<{data:StoredIntent}>('SELECT data FROM hd_me_intents WHERE task_id=$1 ORDER BY created_at',[task.id])).rows.map(r=>r.data);
      if(event.eventName==='TaskFunded') {
        requireThat(meta.quote && same(String(a.buyer),meta.quote.buyer) && same(String(a.taskCommitment),task.sourceCommitment!) && same(String(a.termsHash),meta.termsHash!) && String(a.reviewerFeeWei)===task.quote!.reviewerAtoms && String(a.platformFeeWei)===task.quote!.platformAtoms,'FUNDING_EVENT_MISMATCH','Confirmed funding does not match the immutable signed quote.',503);
        meta.chainTaskId=String(a.taskId);task.status='FUNDED';task.chain!.taskId=meta.chainTaskId;
        await entry(task.id,String(a.buyer),'escrow',BigInt(task.quote!.totalAtoms),'funded');
      } else if(event.eventName==='TaskAssigned') {
        requireThat(same(String(a.reviewer),meta.reviewerWallet),'ASSIGNEE_MISMATCH','The confirmed assignee is not the invited reviewer.',503);
        task.status='ASSIGNED';task.acceptedAt=iso(BigInt(String(a.acceptedAt)));task.deliveryDue=iso(BigInt(String(a.deliveryDue)));
      } else if(event.eventName==='DeliverySubmitted') {
        const proposal=proposals.find(p=>p.private.candidate?.report && same(p.private.candidate.report.deliveryCommitment,String(a.deliveryCommitment)));
        requireThat(proposal?.private.candidate,'DELIVERY_CONTENT_UNAVAILABLE','Confirmed delivery has no matching immutable private report. Restore it before replay.',503);
        const candidate=proposal.private.candidate;
        requireThat(candidate.report && Number(a.verdict)===Verdict[candidate.report.verdict],'DELIVERY_VERDICT_MISMATCH','The confirmed verdict differs from the sealed private report.',503);
        for(const version of candidate.versions)if(!task.versions.some(v=>v.id===version.id))task.versions.push(version);
        task.report=candidate.report;task.report!.submittedAt=at;task.secrets.finalManifest=candidate.secrets.finalManifest;task.secrets.finalSalt=candidate.secrets.finalSalt;
        task.currentVersionId=meta.displayVersionId??task.report!.reviewedVersionId;task.status='SUBMITTED';task.challengeUntil=iso(BigInt(String(a.challengeUntil)));
      } else if(event.eventName==='DisputeOpened') {
        task.status='DISPUTED';task.arbitrationUntil=iso(BigInt(String(a.arbitrationUntil)));
        const proposal=proposals.find(p=>same(p.view.txHash??'',event.transactionHash));task.disputeReason=proposal?.private.candidate?.disputeReason??'Chain dispute; private reason not available.';
      } else if(event.eventName==='TaskClosed') {
        const W=BigInt(String(a.reviewerCreditWei)),P=BigInt(String(a.platformCreditWei)),B=BigInt(String(a.buyerCreditWei));
        requireThat(W+P+B===BigInt(task.quote!.totalAtoms),'ALLOCATION_MISMATCH','Allocation does not conserve the funded amount.',503);
        await entry(task.id,meta.quote.buyer,'escrow',-BigInt(task.quote!.totalAtoms),'escrow-release');
        await entry(task.id,meta.reviewerWallet,'claimable',W,'reviewer');await entry(task.id,this.deploymentReport!.roles.platformRecipient,'claimable',P,'platform');await entry(task.id,meta.quote.buyer,'claimable',B,'buyer');
        task.status='CLOSED';task.closureReason=['NONE','NORMAL','CANCELLED','UNASSIGNED_TIMEOUT','DELIVERY_TIMEOUT','ARBITRATED','DISPUTE_TIMEOUT'][Number(a.reason)]??'UNKNOWN';
      } else if(event.eventName==='ReleaseApproved') {
        requireThat(task.report?.verdict==='PASS' && same(task.report.deliveryCommitment,String(a.deliveryCommitment)) && same(String(a.brandAuthority),meta.quote.buyer) && same(String(a.purposeHash),EXPORT_PURPOSE_HASH),'APPROVAL_EVENT_MISMATCH','Approval does not match this brand and reviewed version.',503);
        const proposal=proposals.find(p=>same(p.private.chainApprovalId??'',String(a.approvalId)));
        const prior=task.approval;if(prior){task.secrets.approvalHistory??=[];task.secrets.approvalHistory.push(prior);}
        task.approval={id:proposal?.private.candidate?.approval?.id??randomUUID(),versionId:task.report.reviewedVersionId,deliveryCommitment:task.report.deliveryCommitment,scope:`${task.locale}:${task.channel}`,expiresAt:iso(BigInt(String(a.expiresAt))),revokedAt:null,approvedAt:at};meta.approvalChainId=String(a.approvalId) as Hex;
      } else if(event.eventName==='ReleaseRevoked') { if(task.approval) task.approval.revokedAt=at; }
      task.chain={...task.chain!,lastTxHash:event.transactionHash,blockNumber:event.blockNumber.toString(),blockHash:event.blockHash};
      task.timeline.push({id:event.id,type:event.eventName,label:`Confirmed on chain · ${event.eventName}`,at,actorId:'chain',executionMode:'me',txHash:event.transactionHash,blockNumber:event.blockNumber.toString(),blockHash:event.blockHash});task.updatedAt=at;task.version++;
      await this.saveTask(sql,task);await this.saveMeta(sql,task.id,meta);
    }
    // Intent confirmation is exclusively performed by exact transaction/receipt verification.
    // Event indexing updates canonical task/ledger state even when a browser disconnected.
  }
  /** Rebuild only derived state from the immutable source/report intents and canonical logs.
   * Run with other API/indexer processes stopped; no contract transaction is sent.
   */
  async reindex() {
    requireThat(this.settings,'ME_CONFIGURATION_REQUIRED',this.configurationError,503);
    await this.syncJob?.catch(()=>undefined);await this.ensureReady();const s=this.settings!;
    await this.db.transaction(async sql=>{
      const addresses=[s.deployment.escrow.toLowerCase(),s.deployment.registry.toLowerCase()];
      await sql.query("INSERT INTO hd_chain_event_archive(event_id,reason,data) SELECT id,'canonical projection replay',data FROM hd_chain_events WHERE chain_id=$1 AND contract IN ($2,$3) ON CONFLICT(event_id) DO NOTHING",[s.network.chainId,...addresses]);
      await sql.query('DELETE FROM hd_me_ledger WHERE event_id IN (SELECT id FROM hd_chain_events WHERE chain_id=$1 AND contract IN ($2,$3))',[s.network.chainId,...addresses]);
      await sql.query('DELETE FROM hd_chain_events WHERE chain_id=$1 AND contract IN ($2,$3)',[s.network.chainId,...addresses]);
      const rows=(await sql.query<{task_id:string;data:TaskMeta}>('SELECT task_id,data FROM hd_live_tasks')).rows;
      for(const row of rows) if(this.matches(row.data.baseline)) {
        const previous=(await sql.query<{data:PrivateTask}>('SELECT data FROM hd_tasks WHERE id=$1',[row.task_id])).rows[0].data;
        const task=structuredClone(row.data.baseline);task.versions=previous.versions;task.version=previous.version+1;
        delete row.data.chainTaskId;delete row.data.approvalChainId;await this.saveTask(sql,task);await this.saveMeta(sql,task.id,row.data);
      }
      const intents=(await sql.query<{data:StoredIntent}>('SELECT data FROM hd_me_intents')).rows;
      for(const {data:r} of intents) if(r.view.chainId===s.network.chainId && r.view.allowedTargets.some(a=>same(a,s.deployment.escrow))) {r.view.applied=false;r.view.confirmations=0;delete r.view.block;delete r.view.error;delete r.view.reconciliation;delete r.private.cancellationHash;if(r.view.txHash)r.view.status='broadcast';await this.saveIntent(sql,r);}
      await sql.query("INSERT INTO hd_chain_cursors(id,next_block,last_hash,state) VALUES($1,$2,NULL,'healthy') ON CONFLICT(id) DO UPDATE SET next_block=excluded.next_block,last_hash=NULL,state='healthy'",[this.cursorId(),s.deployment.fromBlock.toString()]);
    });
    this.syncFault=undefined;this.synchronized=false;
    for(let n=0;n<10000;n++) {
      await this.sync();const row=(await this.db.query<{next_block:string}>('SELECT next_block FROM hd_chain_cursors WHERE id=$1',[this.cursorId()])).rows[0];
      const latest=await s.client.getBlockNumber({cacheTime:0});if(BigInt(row.next_block)>latest-BigInt(s.deployment.confirmations)+1n)return;
    }
    throw new DomainError('REINDEX_LIMIT','Replay reached its bounded iteration limit. Resume replay before enabling writes.',503);
  }
  async balances(user:User) {
    await this.ensureReady();const s=this.settings!,block=await s.client.getBlock(),account=getAddress(user.wallet);
    const [claimable,walletBalance]=await Promise.all([s.client.readContract({address:s.deployment.escrow,abi:reviewEscrowAbi,functionName:'claimableWei',args:[account],blockNumber:block.number}),s.client.getBalance({address:account,blockNumber:block.number})]);
    const ledgerScope=[user.id,s.network.chainId,s.deployment.escrow.toLowerCase(),s.deployment.registry.toLowerCase()];
    const sums=(await this.db.query<{bucket:string;total:string}>('SELECT l.bucket,SUM(l.amount_wei)::text AS total FROM hd_me_ledger l JOIN hd_chain_events e ON e.id=l.event_id WHERE l.account_id=$1 AND e.chain_id=$2 AND e.contract IN ($3,$4) GROUP BY l.bucket',ledgerScope)).rows;
    const sum=(bucket:string)=>sums.find(r=>r.bucket===bucket)?.total??'0';
    const rows=(await this.db.query<{id:string;bucket:string;amount_wei:string;created_at:Date|string;task_id:string|null;tx_hash:string;block_number:string}>('SELECT l.* FROM hd_me_ledger l JOIN hd_chain_events e ON e.id=l.event_id WHERE l.account_id=$1 AND e.chain_id=$2 AND e.contract IN ($3,$4) ORDER BY l.block_number DESC,l.id DESC LIMIT 100',ledgerScope)).rows;
    const canonical=await s.client.getBlock({blockNumber:block.number});requireThat(same(canonical.hash,block.hash),'CHAIN_REORG','Balance reads crossed a reorganization. Retry.',503);
    return {currency:s.network.nativeSymbol,claimableAtoms:claimable.toString(),withdrawnAtoms:sum('withdrawn'),escrowedAtoms:sum('escrow'),walletBalanceAtoms:walletBalance.toString(),executionMode:'me',block:{number:block.number.toString(),hash:block.hash,timestamp:iso(block.timestamp)},reconciliationStatus:this.syncFault?'blocked':BigInt(sum('claimable'))===claimable?'matched':'indexing',entries:rows.map(r=>({id:r.id,type:r.bucket,amountAtoms:String(r.amount_wei),at:new Date(r.created_at).toISOString(),taskId:r.task_id,txHash:r.tx_hash,blockNumber:String(r.block_number)}))};
  }
  async verifyExport(task:PrivateTask,user:User,versionId:string,approvalId:string,sql:Sql=this.db) {
    await this.ensureReady();requireThat(!this.syncFault && this.synchronized,'CHAIN_SYNC_REQUIRED','Fresh canonical chain state is required for export.',503);
    const asset=domain.verifyExport(task,user,versionId,approvalId,this.now()),meta=await this.meta(sql,task.id),s=this.settings!;
    requireThat(meta.approvalChainId,'APPROVAL_NOT_CONFIRMED','The approval is not confirmed on chain.');
    const block=await s.client.getBlock();
    const valid=await s.client.readContract({address:s.deployment.registry,abi:releaseRegistryAbi,functionName:'isValidApproval',args:[meta.approvalChainId,task.report!.deliveryCommitment as Hex,EXPORT_PURPOSE_HASH],blockNumber:block.number});
    requireThat(valid,'APPROVAL_EXPIRED_OR_REVOKED','The on-chain approval is invalid, expired or revoked.');
    const canonical=await s.client.getBlock({blockNumber:block.number});requireThat(same(canonical.hash,block.hash),'CHAIN_REORG','Approval validation crossed a reorganization. Retry.',503);
    return {asset,chain:{chainId:s.network.chainId,network:s.network.network,escrow:s.deployment.escrow,registry:s.deployment.registry,taskId:meta.chainTaskId,approvalId:meta.approvalChainId,blockNumber:block.number.toString(),blockHash:block.hash,blockTimestamp:iso(block.timestamp)}};
  }
}
