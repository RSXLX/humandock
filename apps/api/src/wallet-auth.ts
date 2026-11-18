import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { DomainError, requireThat, type User } from '../../../packages/domain/src/model.js';
import type { Database } from './storage.js';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const walletUserId = (wallet: string) => `wallet:${wallet.toLowerCase()}`;
export type AppSession = { user: User; csrfToken: string; mode?: 'demo' | 'me'; chainId?: number };

export class WalletAuth {
  constructor(private db: Database, private chainId: number, private origin: string, private reviewers: Address[], private now: () => number) {}
  async challenge(address: Address, requestedChain: number) {
    requireThat(requestedChain === this.chainId, 'CHAIN_MISMATCH', 'Switch the wallet to the configured network.', 400);
    const wallet = getAddress(address), id = randomUUID(), browserToken = randomBytes(32).toString('hex');
    const expiresAt = new Date(this.now() + 5 * 60_000), location = new URL(this.origin);
    const message = createSiweMessage({ scheme: location.protocol.slice(0,-1), domain: location.host, address: wallet,
      statement: 'Sign in to HumanDock. This proves wallet control only; it does not authorize a transaction or certify ME identity.',
      uri: location.origin, version: '1', chainId: this.chainId, nonce: randomBytes(16).toString('hex'), issuedAt: new Date(this.now()), expirationTime: expiresAt, requestId: id });
    await this.db.query('INSERT INTO hd_auth_challenges(id,browser_hash,address,chain_id,message,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id,digest(browserToken),wallet,this.chainId,message,expiresAt.toISOString()]);
    return { challengeId: id, message, expiresAt: expiresAt.toISOString(), browserToken };
  }
  async verify(id: string, signature: Hex, browserToken: string | undefined, oldSession?: string) {
    requireThat(browserToken, 'LOGIN_BROWSER_MISMATCH', 'Start a new sign-in challenge in this browser.', 401);
    return this.db.transaction(async sql => {
      const row = (await sql.query<{ browser_hash: string; address: Address; chain_id: string | number; message: string; expires_at: Date | string; consumed: boolean }>('SELECT * FROM hd_auth_challenges WHERE id=$1', [id])).rows[0];
      requireThat(row && !row.consumed && new Date(row.expires_at).getTime() > this.now(), 'LOGIN_CHALLENGE_EXPIRED', 'Sign-in challenge is expired or already used.', 401);
      requireThat(row.browser_hash === digest(browserToken!) && Number(row.chain_id) === this.chainId, 'LOGIN_BROWSER_MISMATCH', 'Sign-in challenge does not belong to this browser/network.', 401);
      let signer: Address;
      try { signer = await recoverMessageAddress({ message: row.message, signature }); } catch { throw new DomainError('LOGIN_SIGNATURE_INVALID','Invalid wallet signature.',401); }
      requireThat(signer.toLowerCase() === row.address.toLowerCase(), 'LOGIN_SIGNATURE_INVALID', 'Wallet signature does not match the challenge address.', 401);
      await sql.query('UPDATE hd_auth_challenges SET consumed=true WHERE id=$1', [id]);
      if (oldSession) await sql.query('DELETE FROM hd_sessions WHERE token_hash=$1', [digest(oldSession)]);
      const wallet = getAddress(row.address), reviewer = this.reviewers.some(a => a.toLowerCase() === wallet.toLowerCase());
      const user: User = { id: walletUserId(wallet), name: `${reviewer ? 'Reviewer' : 'Brand'} ${wallet.slice(0,6)}…${wallet.slice(-4)}`, wallet,
        role: reviewer ? 'reviewer' : 'buyer', orgId: `unverified:${wallet.toLowerCase()}`, identity: { status: 'pending', label: 'Wallet signed in; ME identity has not been checked.' } };
      const session: AppSession = { user, mode: 'me', chainId: this.chainId, csrfToken: randomBytes(24).toString('hex') }, token = randomBytes(32).toString('hex');
      await sql.query('INSERT INTO hd_sessions(token_hash,data,expires_at) VALUES($1,$2::jsonb,$3)', [digest(token),JSON.stringify(session),new Date(this.now()+8*3600_000).toISOString()]);
      return { session, token };
    });
  }
}
