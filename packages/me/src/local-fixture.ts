/** TEST/LOCAL ONLY: importing this explicit module uses Ganache and deterministic public test keys.
 * It is deliberately NOT exported from the production package index.
 */
import ganache from 'ganache';
import { custom, createWalletClient, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from '../../../scripts/compile-contracts.js';
import { createMePublicClient, type RoleAddresses } from './chain.js';
import { deployHumanDock } from './deployment.js';
import type { MeNetworkConfig } from './config.js';

export const LOCAL_TEST_MNEMONIC = 'test test test test test test test test test test test junk';
export async function deployLocalFixture(options: { provider?: ReturnType<typeof ganache.provider>; quantumWei?: bigint; chainId?: number } = {}) {
  const chainId = options.chainId ?? 31337;
  const quantumWei = options.quantumWei ?? 1n;
  let bankDecimals = 18;
  while (10n ** BigInt(18 - bankDecimals) < quantumWei && bankDecimals > 0) bankDecimals--;
  if (10n ** BigInt(18 - bankDecimals) !== quantumWei) throw new Error('Local fixture quantum must be a decimal power no greater than 10^18');
  const provider = options.provider ?? ganache.provider({ logging: { quiet: true }, wallet: { mnemonic: LOCAL_TEST_MNEMONIC, totalAccounts: 12, defaultBalance: 1000 }, chain: { chainId, hardfork: 'merge' }, miner: { timestampIncrement: 0 } });
  const config: MeNetworkConfig = { network: 'local', chainId, rpcUrl: 'http://127.0.0.1:18545', nativeSymbol: 'LOCAL', evmDecimals: 18, bankDenom: 'local_atom', bankDecimals, quantumWei };
  const transport = custom(provider as any);
  const client = createMePublicClient(config, { transport });
  const secrets = Object.values(provider.getInitialAccounts() as Record<string, { secretKey: Hex }>);
  const accounts = secrets.map(({ secretKey }) => privateKeyToAccount(secretKey as Hex));
  if (accounts.length < 10) throw new Error('Local fixture requires at least 10 Ganache accounts');
  const wallets = accounts.map((account) => createWalletClient({ account, chain: client.chain, transport }));
  const roles: RoleAddresses = { owner: accounts[0].address, quoteSigner: accounts[1].address, assignmentSigner: accounts[2].address, deliveryGate: accounts[3].address, arbitrator: accounts[4].address, platformRecipient: accounts[5].address };
  const artifacts = await compileContracts(false);
  const deployment = await deployHumanDock({ client, wallet: wallets[0], config, artifacts: { ReviewEscrow: artifacts.ReviewEscrow, ReleaseRegistry: artifacts.ReleaseRegistry }, roles, maxTaskFeeWei: 100n * 10n ** 18n, confirmations: 1 });
  return {
    label: 'local_test' as const, provider, config, client, accounts, wallets, deployment, roles,
    /** Account 6 buyer; 7 reviewer; 8 keeper/relayer; issuer keys are explicit test dependencies. */
    buyer: accounts[6], reviewer: accounts[7], quoteSigner: accounts[1], assignmentSigner: accounts[2], deliveryGateSigner: accounts[3],
    close: async () => { if (!options.provider) await provider.disconnect(); },
  };
}
