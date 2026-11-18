import { buildApp } from './server.js';
import { existsSync } from 'node:fs';
import { parseMode, validateBindHost } from './config.js';
if (existsSync('.env')) process.loadEnvFile('.env');
const host = process.env.API_HOST ?? '127.0.0.1';
const mode = parseMode(process.env.APP_MODE);
validateBindHost(mode, host);
const app = await buildApp({logger:true});
await app.listen({port:Number(process.env.API_PORT ?? 4000),host});
async function stop() { await app.close(); process.exit(0); }
process.on('SIGINT',stop);process.on('SIGTERM',stop);
