import { existsSync } from 'node:fs';
import { Database } from '../apps/api/src/storage.js';
import { loadLiveSettings } from '../apps/api/src/live-config.js';
import { MeWorkflow } from '../apps/api/src/live-workflow.js';

// Operator recovery only. Stop API/indexer processes and back up their database first.
// Replays confirmed logs; never signs, deploys, broadcasts, or transfers funds.
let db:Database|undefined,workflow:MeWorkflow|undefined;
try {
  if(existsSync('.env'))process.loadEnvFile('.env');
  if(process.env.APP_MODE!=='me')throw new Error('APP_MODE=me is required for a chain projection replay');
  if(!process.argv.includes('--execute'))throw new Error('Stop API/indexer processes, back up the database, then run me:reindex -- --execute. Replay rebuilds derived state and archives existing event evidence.');
  const settings=loadLiveSettings();
  db=new Database({url:process.env.DATABASE_URL,dataDir:process.env.DATA_DIR});await db.start();
  workflow=new MeWorkflow(db,{...settings,syncIntervalMs:0});
  await workflow.reindex();
  console.log(JSON.stringify({ok:true,transactionsSent:false,chainId:settings.network.chainId,contracts:{escrow:settings.deployment.escrow,registry:settings.deployment.registry},state:workflow.config().sync}));
}catch(error){console.error(JSON.stringify({ok:false,transactionsSent:false,error:error instanceof Error?error.message:'Canonical replay failed'}));process.exitCode=1;}
finally{await workflow?.stop();await db?.close();}
