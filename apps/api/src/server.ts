import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { canonicalJson, textHash } from '../../../packages/domain/src/commitments.js';
import { CRITERIA, DomainError, publicTask, requireThat, type Allocation, type PrivateTask, type User } from '../../../packages/domain/src/model.js';
import * as domain from '../../../packages/domain/src/tasks.js';
import { Database, type Sql } from './storage.js';
import { suggest } from './assistance.js';
import { parseMode } from './config.js';
import { getAddress, type Address, type Hex } from 'viem';
import { loadLiveSettings, type LiveSettings } from './live-config.js';
import { WalletAuth, type AppSession } from './wallet-auth.js';
import { MeWorkflow, CHAIN_ACTIONS } from './live-workflow.js';
declare module 'fastify' { interface FastifyInstance { meWorkflow?: MeWorkflow } }

type Session = AppSession;
type ExportRecord = { id: string; taskId: string; versionId: string; approvalId: string; filename: string; downloadUrl: string; receiptUrl: string; verifiedAt: string; executionMode: 'demo'|'me' };
type Options = { database?: Database; mode?: 'demo'|'me'; now?: () => number; logger?: boolean; origins?: string[]; liveSettings?: LiveSettings };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const v = z.object({expectedVersion: z.number().int().positive()});
const shortText = z.string().min(1).max(6000).refine(s => s.trim().length > 0 && s.trim().split(/\s+/).length <= 300, 'Maximum 300 English words.');
const taskInput = z.object({ title: z.string().trim().min(3).max(120), sourceText: shortText, facts: z.string().trim().min(10).max(2000), channel: z.enum(['tiktok_text','instagram_text','youtube_text','x_text']), locale: z.literal('en-US') }).strict();
const checks = z.array(z.object({ criterion: z.enum(CRITERIA), result: z.enum(['OK','ISSUE','UNKNOWN']), comment: z.string().trim().min(1).max(1500), evidenceRefs: z.array(z.string().max(200)).max(20) })).length(5);
const walletAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(value=>getAddress(value));
const signature = z.string().regex(/^0x[0-9a-fA-F]{128}(?:[0-9a-fA-F]{2})?$/).transform(value=>value as Hex);
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value=>value.toLowerCase() as Hex);

export async function buildApp(options: Options = {}) {
  const mode = parseMode(options.mode ?? process.env.APP_MODE);
  const now = options.now ?? Date.now;
  const db = options.database ?? new Database({url: process.env.DATABASE_URL, dataDir: process.env.DATA_DIR});
  await db.start();
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024, requestTimeout: mode==='me'?120000:20000, trustProxy: false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  const origins = new Set(options.origins ?? [process.env.WEB_ORIGIN ?? 'http://localhost:3000', 'http://127.0.0.1:3000']);
  const webOrigin=[...origins][0];
  let liveSettings=options.liveSettings, configurationError='ME configuration is incomplete.';
  if(mode==='me' && !liveSettings) {try{liveSettings=loadLiveSettings();}catch(error){configurationError=error instanceof Error?error.message:configurationError;}}
  const live=mode==='me'?new MeWorkflow(db,liveSettings,now,configurationError):undefined;
  const walletAuth=liveSettings && mode==='me'?new WalletAuth(db,liveSettings.network.chainId,webOrigin,liveSettings.reviewers,now):undefined;
  const secureCookie=mode==='me' && new URL(webOrigin).protocol==='https:';
  app.addHook('onClose', async () => {await live?.stop();await db.close();});
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff');
    if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      requireThat(!origin || origins.has(origin), 'ORIGIN_FORBIDDEN', 'Request origin is not permitted.', 403);
      requireThat(req.headers['sec-fetch-site'] !== 'cross-site', 'ORIGIN_FORBIDDEN', 'Cross-site writes are not permitted.', 403);
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DomainError) return reply.status(error.statusCode).send({error:{code:error.code,message:error.message}});
    if (error instanceof z.ZodError) return reply.status(400).send({error:{code:'VALIDATION_ERROR',message:error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}});
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (status === 429) return reply.status(429).send({error:{code:'RATE_LIMITED',message:'Too many requests. Please wait.'}});
    req.log.error({err:error}, 'Request failed');
    return reply.status(status >= 400 && status < 500 ? status : 500).send({error:{code:'REQUEST_FAILED',message:status < 500 ? 'Invalid request.' : 'The request could not be completed.'}});
  });

  async function session(req: FastifyRequest, optional = false): Promise<Session | null> {
    const token = req.cookies.hd_session;
    if (!token) { requireThat(optional, 'AUTH_REQUIRED', 'Sign in to continue.', 401); return null; }
    const row = (await db.query<{data:Session}>('SELECT data FROM hd_sessions WHERE token_hash=$1 AND expires_at>$2', [sha(token),new Date(now()).toISOString()])).rows[0];
    if (!row || (row.data.mode??'demo')!==mode || (mode==='me' && row.data.chainId!==liveSettings?.network.chainId)) { requireThat(optional, 'AUTH_REQUIRED', 'Session expired or belongs to another execution mode/network. Sign in again.', 401); return null; }
    return row.data;
  }
  async function authenticated(req: FastifyRequest): Promise<Session> { return (await session(req))!; }
  async function writeSession(req: FastifyRequest): Promise<Session> {
    const s = await authenticated(req);
    const token = req.headers['x-csrf-token'];
    const provided = Buffer.from(typeof token === 'string' ? token : '');
    const expected = Buffer.from(s.csrfToken);
    requireThat(provided.length === expected.length && timingSafeEqual(provided, expected), 'CSRF_INVALID', 'Refresh your session and retry.', 403);
    return s;
  }
  function demoOnly() { requireThat(mode === 'demo', 'ME_INTEGRATION_PENDING', 'ME writes are disabled until identity, network, deployment and transaction indexing are verified.', 503); }
  function meOnly() {requireThat(mode==='me' && live && walletAuth,'ME_CONFIGURATION_REQUIRED',configurationError,503);return live;}
  async function persistSession(req:FastifyRequest,s:Session) {await db.query('UPDATE hd_sessions SET data=$2::jsonb WHERE token_hash=$1',[sha(req.cookies.hd_session!),JSON.stringify(s)]);}
  async function admit(req:FastifyRequest) {const s=await writeSession(req),me=meOnly();await me.sync();try{await me.admit(s.user);}finally{await persistSession(req,s);}}
  async function getTask(sql: Sql, id: string, user: User): Promise<PrivateTask> {
    z.uuid().parse(id);
    if(mode==='me')return meOnly().task(sql,id,user);
    const row = (await sql.query<{data:PrivateTask}>('SELECT data FROM hd_tasks WHERE id=$1 AND (org_id=$2 OR reviewer_id=$3 OR buyer_id=$3)',[id,user.orgId,user.id])).rows[0];
    requireThat(row && row.data.executionMode==='demo', 'NOT_FOUND', 'Task not found.', 404); domain.assertRead(row.data,user); return row.data;
  }
  async function saveTask(sql: Sql, task: PrivateTask) {
    await sql.query('UPDATE hd_tasks SET data=$2::jsonb, version=$3 WHERE id=$1',[task.id,JSON.stringify(task),task.version]);
  }
  async function ledger(sql:Sql, taskId:string|null, accountId:string,bucket:'escrow'|'claimable'|'withdrawn',amount:bigint,type:string) {
    await sql.query('INSERT INTO hd_ledger(id,task_id,account_id,bucket,entry_type,amount_atoms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),taskId,accountId,bucket,type,amount.toString(),new Date(now()).toISOString()]);
  }
  async function allocate(sql: Sql, task: PrivateTask, allocations: Allocation[]) {
    await ledger(sql,task.id,task.buyerId,'escrow',-BigInt(task.quote!.totalAtoms),'ESCROW_RELEASE');
    for (const a of allocations) if (a.amountAtoms > 0n) await ledger(sql,task.id,a.accountId,'claimable',a.amountAtoms,'SERVICE_ALLOCATION');
  }
  async function balances(sql:Sql,user:User) {
    const sums = (await sql.query<{bucket:string;total:string}>('SELECT bucket,SUM(amount_atoms)::text AS total FROM hd_ledger WHERE account_id=$1 GROUP BY bucket',[user.id])).rows;
    const sum = (bucket:string) => sums.find(s => s.bucket === bucket)?.total ?? '0';
    const rows = (await sql.query<{id:string;entry_type:string;amount_atoms:string;created_at:Date|string;task_id:string|null}>('SELECT id,entry_type,amount_atoms::text,created_at,task_id FROM hd_ledger WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[user.id])).rows;
    return {currency:'DEMO',claimableAtoms:sum('claimable'),withdrawnAtoms:sum('withdrawn'),escrowedAtoms:sum('escrow'),entries:rows.map(r => ({id:r.id,type:r.entry_type,amountAtoms:r.amount_atoms,at:new Date(r.created_at).toISOString(),taskId:r.task_id}))};
  }
  async function mutate(req:FastifyRequest, action:(sql:Sql,user:User)=>Promise<unknown>) {
    const s = await writeSession(req);
    const key = req.headers['idempotency-key'];
    requireThat(typeof key === 'string' && key.length >= 8 && key.length <= 128,'IDEMPOTENCY_KEY_REQUIRED','Send a unique Idempotency-Key.',400);
    const route = req.url.split('?')[0], bodyHash = textHash(canonicalJson(req.body ?? {}));
    const actorId=mode==='demo'?s.user.id:`me:${liveSettings?.network.chainId}:${liveSettings?.deployment.escrow.toLowerCase()}:${s.user.id}`;
    return db.transaction(async sql => {
      const old = (await sql.query<{body_hash:string;response:unknown}>('SELECT body_hash,response FROM hd_idempotency WHERE actor_id=$1 AND route=$2 AND key=$3',[actorId,route,key])).rows[0];
      if (old) {
        requireThat(old.body_hash === bodyHash,'IDEMPOTENCY_CONFLICT','This key was used for different input.');
        const response=old.response as {intent?:{id?:string};export?:ExportRecord};
        // Retrying preparation must not revive a pre-broadcast snapshot of an intent.
        if(mode==='me' && response?.intent?.id)return {...response,intent:(await meOnly().intent(sql,response.intent.id,s.user)).view};
        if(response?.export) {
          const ex=response.export,task=await getTask(sql,ex.taskId,s.user);
          if(mode==='me')await meOnly().verifyExport(task,s.user,ex.versionId,ex.approvalId,sql);else domain.verifyExport(task,s.user,ex.versionId,ex.approvalId,now());
        }
        return old.response;
      }
      const result = await action(sql,s.user);
      await sql.query('INSERT INTO hd_idempotency(actor_id,route,key,body_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[actorId,route,key,bodyHash,JSON.stringify(result)]);
      await sql.query('INSERT INTO hd_audit(id,actor_id,action,resource_id,created_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),s.user.id,route,(req.params as {id?:string}).id ?? 'collection',new Date(now()).toISOString()]);
      return result;
    });
  }
  // Reconciliation and identity refresh are idempotent reads of changing external state.
  // Record key/body consistency, but never cache an old confirmation or KYC response.
  async function freshMutation(req:FastifyRequest,work:(s:Session)=>Promise<unknown>) {
    await mutate(req,async()=>({fresh:true}));return work(await writeSession(req));
  }
  app.get('/v1/health', async () => ({ok:true,mode,storage:db.kind,chain:{status:live?.config().status??(process.env.ME_EVM_RPC_URL?'configured_unverified':'not_configured'),name:'MetaEarth'},ai:{mode:process.env.AI_API_KEY && process.env.AI_API_URL && process.env.AI_MODEL?'provider':'rules'},version:'0.2.0'}));
  app.get('/v1/me/config',async()=>{if(!live)return {mode,status:'not_configured',writesEnabled:false,admissionsEnabled:false,reasons:['Switch the server to a verified ME configuration.'],admissionReasons:[],network:null,contracts:null,confirmations:0,localTest:false};await live.sync().catch(()=>undefined);return live.config();});
  app.get('/v1/session', async req => { const s=await session(req,true); return {user:s?.user??null,csrfToken:s?.csrfToken??null,mode}; });
  app.post('/v1/auth/challenge',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
    meOnly();const b=z.object({address:walletAddress,chainId:z.number().int().positive()}).strict().parse(req.body);
    const challenge=await walletAuth!.challenge(b.address,b.chainId);
    reply.setCookie('hd_challenge',challenge.browserToken,{httpOnly:true,sameSite:'strict',secure:secureCookie,path:'/',maxAge:300});
    const {browserToken:_token,...publicChallenge}=challenge;return publicChallenge;
  });
  app.post('/v1/auth/verify',{config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(req,reply)=>{
    meOnly();const b=z.object({challengeId:z.uuid(),signature}).strict().parse(req.body);
    const result=await walletAuth!.verify(b.challengeId,b.signature,req.cookies.hd_challenge,req.cookies.hd_session);
    reply.clearCookie('hd_challenge',{path:'/'});reply.setCookie('hd_session',result.token,{httpOnly:true,sameSite:'strict',secure:secureCookie,path:'/',maxAge:8*3600});return result.session;
  });
  app.post('/v1/me/identity/refresh',async req=>freshMutation(req,async s=>{const me=meOnly();z.object({}).strict().parse(req.body);await me.refreshIdentity(s.user);await persistSession(req,s);return {...s,mode};}));
  app.get('/v1/me/reviewers',async req=>{await authenticated(req);meOnly();return {reviewers:liveSettings!.reviewers.map(wallet=>({wallet,name:`Reviewer ${wallet.slice(0,6)}…${wallet.slice(-4)}`}))};});
  app.post('/v1/me/intents',async req=>{
    const b=z.object({action:z.enum(CHAIN_ACTIONS),taskId:z.uuid().optional(),expectedVersion:z.number().int().positive().optional(),payload:z.record(z.string(),z.unknown()).optional()}).strict().parse(req.body);
    const me=meOnly();await writeSession(req);
    if(['fund','accept-assignment'].includes(b.action)) await admit(req);else await me.sync();
    return mutate(req,async(sql,user)=>({intent:await me.prepare(sql,user,b.action,b.taskId,b.expectedVersion,b.payload)}));
  });
  app.get('/v1/me/intents',async req=>({intents:await meOnly().listIntents((await authenticated(req)).user)}));
  app.get('/v1/me/intents/:id',async req=>{const {user}=await authenticated(req);return {intent:(await meOnly().intent(db,z.uuid().parse((req.params as {id:string}).id),user)).view};});
  app.post('/v1/me/intents/:id/signature',async req=>{const me=meOnly();await writeSession(req);await me.sync();return mutate(req,async(sql,user)=>({intent:await me.attachSignature(sql,user,z.uuid().parse((req.params as {id:string}).id),z.object({signature}).strict().parse(req.body).signature)}));});
  app.post('/v1/me/intents/:id/broadcast',async req=>mutate(req,async(sql,user)=>({intent:await meOnly().broadcast(sql,user,z.uuid().parse((req.params as {id:string}).id),z.object({txHash}).strict().parse(req.body).txHash)})));
  app.post('/v1/me/intents/:id/reconcile',async req=>freshMutation(req,async s=>{z.object({}).strict().parse(req.body);return meOnly().reconcile(s.user,z.uuid().parse((req.params as {id:string}).id));}));
  app.post('/v1/demo/session', {config:{rateLimit:{max:30,timeWindow:'1 minute'}}}, async (req,reply) => {
    demoOnly(); const {role}=z.object({role:z.enum(['buyer','reviewer','outsider'])}).strict().parse(req.body);
    const token=randomBytes(32).toString('hex'), s:Session={user:domain.DEMO_USERS[role],csrfToken:randomBytes(24).toString('hex'),mode:'demo'};
    await db.transaction(async sql => {
      if(req.cookies.hd_session) await sql.query('DELETE FROM hd_sessions WHERE token_hash=$1',[sha(req.cookies.hd_session)]);
      await sql.query('INSERT INTO hd_sessions(token_hash,data,expires_at) VALUES($1,$2::jsonb,$3)',[sha(token),JSON.stringify(s),new Date(now()+8*domain.HOUR).toISOString()]);
    });
    reply.setCookie('hd_session',token,{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:8*3600});
    return {...s,mode};
  });
  app.post('/v1/logout', async (req,reply) => { await writeSession(req); await db.query('DELETE FROM hd_sessions WHERE token_hash=$1',[sha(req.cookies.hd_session!)]);reply.clearCookie('hd_session',{path:'/'});return {ok:true}; });
  app.get('/v1/tasks', async req => {
    const {user}=await authenticated(req);
    const rows=(await db.query<{data:PrivateTask}>('SELECT data FROM hd_tasks WHERE org_id=$1 OR reviewer_id=$2 OR buyer_id=$2 ORDER BY created_at DESC',[user.orgId,user.id])).rows;
    return {tasks:rows.map(r=>r.data).filter(t=>domain.canRead(t,user)&&(mode==='demo'?t.executionMode==='demo':live!.matches(t))).map(publicTask)};
  });
  app.get('/v1/tasks/:id', async req => { const {user}=await authenticated(req);return {task:publicTask(await getTask(db,(req.params as {id:string}).id,user))}; });
  app.post('/v1/tasks', async req => {if(mode==='me')await admit(req);return mutate(req,async (sql,user) => {
    if(mode==='me'){const {reviewerWallet,...input}=taskInput.extend({reviewerWallet:walletAddress}).parse(req.body);return {task:publicTask(await meOnly().createTask(sql,user,input,reviewerWallet))};}
    const task=domain.createTask(user,taskInput.parse(req.body),now());
    await sql.query('INSERT INTO hd_tasks(id,org_id,buyer_id,reviewer_id,version,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[task.id,task.orgId,task.buyerId,task.reviewerId,task.version,JSON.stringify(task)]);
    return {task:publicTask(task)};
  });});
  const operations:Record<string,(sql:Sql,t:PrivateTask,u:User,body:any)=>Promise<void>|void>={
    quotes:(_s,t,u)=>domain.quoteTask(t,u,now()),
    fund:async(s,t,u)=>{domain.fundTask(t,u,now());await ledger(s,t.id,t.buyerId,'escrow',BigInt(t.quote!.totalAtoms),'DEMO_FUND');},
    'accept-assignment':(_s,t,u)=>domain.acceptAssignment(t,u,now()),
    reviews:(_s,t,u,body)=>domain.submitReview(t,u,z.object({reviewedText:shortText,verdict:z.enum(['PASS','CHANGES_REQUIRED','BLOCK']),summary:z.string().trim().min(10).max(2000),checks}).parse(body),now()),
    'accept-service':async(s,t,u)=>allocate(s,t,domain.acceptService(t,u,now())),
    approvals:(_s,t,u,body)=>{const b=z.object({versionId:z.uuid(),expiresInHours:z.union([z.literal(24),z.literal(72),z.literal(168)])}).parse(body);domain.approveTask(t,u,b.versionId,b.expiresInHours,now());},
    revoke:(_s,t,u)=>domain.revokeTask(t,u,now()),
    versions:(_s,t,u,body)=>domain.addVersion(t,u,z.object({text:shortText}).parse(body).text,now()),
    cancel:async(s,t,u)=>allocate(s,t,domain.cancelTask(t,u,now())),
    disputes:(_s,t,u,body)=>domain.openDispute(t,u,z.object({reason:z.string().trim().min(10).max(2000)}).parse(body).reason,now()),
    timeouts:async(s,t,u)=>allocate(s,t,domain.timeoutTask(t,u,now())),
  };
  for(const [action,run] of Object.entries(operations)) app.post(`/v1/tasks/:id/${action}`,async req=>{if(mode==='me' && action==='quotes')await admit(req);return mutate(req,async(sql,user)=>{
    const body=v.passthrough().parse(req.body);const task=await getTask(sql,(req.params as {id:string}).id,user);
    if(mode==='me') {
      domain.expected(task,body.expectedVersion);
      if(action==='quotes')await meOnly().quoteTask(sql,task,user);
      else if(action==='versions')await meOnly().changedVersion(sql,task,user,z.object({text:shortText}).parse(body).text);
      else throw new DomainError('TRANSACTION_INTENT_REQUIRED','Prepare, sign and confirm a wallet transaction through /me/intents before changing chain state.',409);
      return {task:publicTask(task)};
    }
    domain.expected(task,body.expectedVersion);await run(sql,task,user,body);await saveTask(sql,task);return {task:publicTask(task)};
  });});
  app.post('/v1/tasks/:id/ai-checks',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async req=>{
    const {user}=await writeSession(req);const task=await getTask(db,(req.params as {id:string}).id,user);
    return suggest(task.sourceText,task.facts);
  });
  app.post('/v1/exports',async req=>{if(mode==='me'){await writeSession(req);await meOnly().sync();}return mutate(req,async(sql,user)=>{
    const b=z.object({taskId:z.uuid(),versionId:z.uuid(),approvalId:z.uuid()}).strict().parse(req.body);
    const task=await getTask(sql,b.taskId,user);if(mode==='me')await meOnly().verifyExport(task,user,b.versionId,b.approvalId,sql);else domain.verifyExport(task,user,b.versionId,b.approvalId,now());
    const id=randomUUID(), ex:ExportRecord={id,...b,filename:`humandock-${task.id.slice(0,8)}.txt`,downloadUrl:`/api/v1/exports/${id}/download`,receiptUrl:`/api/v1/exports/${id}/receipt`,verifiedAt:new Date(now()).toISOString(),executionMode:mode};
    await sql.query('INSERT INTO hd_exports(id,org_id,task_id,data) VALUES($1,$2,$3,$4::jsonb)',[id,user.orgId,task.id,JSON.stringify(ex)]);
    return {export:ex};
  });});
  async function exportContext(req:FastifyRequest) {
    const {user}=await authenticated(req),id=z.uuid().parse((req.params as {id:string}).id);
    const row=(await db.query<{data:ExportRecord}>('SELECT data FROM hd_exports WHERE id=$1',[id])).rows[0];
    requireThat(row && row.data.executionMode===mode,'NOT_FOUND','Export not found.',404);const ex=row.data;
    if(mode==='me')await meOnly().sync();
    const task=await getTask(db,ex.taskId,user);
    if(mode==='me')return {ex,task,...await meOnly().verifyExport(task,user,ex.versionId,ex.approvalId)};
    return {ex,task,asset:domain.verifyExport(task,user,ex.versionId,ex.approvalId,now()),chain:null};
  }
  app.get('/v1/exports/:id/download',async(req,reply)=>{const {ex,asset}=await exportContext(req);return reply.type('text/plain; charset=utf-8').header('Content-Disposition',`attachment; filename="${ex.filename}"`).send(asset.text);});
  app.get('/v1/exports/:id/receipt',async req=>{const {ex,task,asset,chain}=await exportContext(req);return {schemaVersion:mode==='demo'?'receipt.demo.v1':'receipt.chain.v1',notice:mode==='demo'?'LOCAL DEMO — NOT A ME ATTESTATION OR TRANSACTION':liveSettings!.network.network==='local'?'LOCAL TEST CHAIN — NOT ME CERTIFICATION':'Approval verified against the configured chain at the recorded block. This is not legal or platform certification.',executionMode:mode,taskId:task.id,versionId:asset.id,contentHash:asset.contentHash,approval:task.approval,reportId:task.report!.id,deliveryCommitment:task.report!.deliveryCommitment,finalManifest:task.secrets.finalManifest,finalSalt:task.secrets.finalSalt,verifiedAt:new Date(now()).toISOString(),exportCreatedAt:ex.verifiedAt,chain};});
  app.get('/v1/balances',async req=>{const {user}=await authenticated(req);return mode==='me'?meOnly().balances(user):balances(db,user);});
  app.post('/v1/withdrawals',async req=>mutate(req,async(sql,user)=>{
    requireThat(mode==='demo','TRANSACTION_INTENT_REQUIRED','Use a wallet withdrawal intent and confirm its receipt.',409);
    const b=await balances(sql,user),amount=BigInt(b.claimableAtoms);requireThat(amount>0n,'NO_CLAIMABLE_BALANCE','There are no local credits to withdraw.');
    await ledger(sql,null,user.id,'claimable',-amount,'DEMO_WITHDRAWAL');await ledger(sql,null,user.id,'withdrawn',amount,'DEMO_WITHDRAWAL');return balances(sql,user);
  }));
  app.post('/v1/tasks/:id/funding-intents',async req=>{await writeSession(req);throw new DomainError('TRANSACTION_INTENT_REQUIRED','Use POST /v1/me/intents with action fund.',409);});
  await live?.start();
  return Object.assign(app,{meWorkflow:live});
}
