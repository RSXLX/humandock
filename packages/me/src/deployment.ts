import { keccak256, type Abi, type Account, type Address, type Hex } from 'viem';
import { MeChainError, verifyDeployment, type DeploymentConfig, type MePublicClient, type RoleAddresses } from './chain.js';
import type { MeNetworkConfig } from './config.js';

export interface DeployableArtifact { abi: readonly unknown[]; bytecode: Hex; compilerVersion: string; evmVersion: string }
export interface DeploymentWallet { account?: Account; deployContract: (parameters: any) => Promise<Hex> }
export interface DeploymentManifest extends DeploymentConfig {
  schema: 'humandock.deployment.v1'; chainId: number; network: MeNetworkConfig['network'];
  quantumWei: bigint; maxTaskFeeWei: bigint; expectedRoles: RoleAddresses;
  transactions: { escrow: Hex; registry: Hex }; compilerVersion: string; evmVersion: 'paris';
}

/** Caller supplies an explicitly authorized signer. Default is local-only deployment. */
export async function deployHumanDock(input: {
  client: MePublicClient; wallet: DeploymentWallet; config: MeNetworkConfig;
  artifacts: { ReviewEscrow: DeployableArtifact; ReleaseRegistry: DeployableArtifact };
  roles: RoleAddresses; maxTaskFeeWei: bigint; confirmations: number;
  explicitRemoteAuthorization?: { chainId: number; deployer: Address; acknowledgment: 'DEPLOY_REVIEWED_HUMANDOCK_CONTRACTS' };
}): Promise<DeploymentManifest> {
  const { client, wallet, config, roles, artifacts } = input;
  if (!wallet.account) throw new MeChainError('SIGNER_REQUIRED', 'Explicit deployment account required');
  if (config.network === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.rpcUrl).hostname)) throw new MeChainError('LOCAL_ENDPOINT_REQUIRED', 'Automatic local deployment must use a loopback RPC endpoint');
  if (await client.getChainId() !== config.chainId) throw new MeChainError('CHAIN_MISMATCH', 'Deployment RPC does not match configured chain');
  if (!Number.isSafeInteger(input.confirmations) || input.confirmations < 1) throw new MeChainError('INVALID_CONFIRMATIONS', 'Deployment requires explicit positive confirmations');
  if (config.quantumWei <= 0n || input.maxTaskFeeWei <= 0n || input.maxTaskFeeWei % config.quantumWei !== 0n) throw new MeChainError('INVALID_AMOUNT', 'Deployment cap must be positive and quantum aligned');
  if (config.network !== 'local') {
    const authorization = input.explicitRemoteAuthorization;
    if (!authorization || authorization.chainId !== config.chainId || authorization.deployer.toLowerCase() !== wallet.account.address.toLowerCase() || authorization.acknowledgment !== 'DEPLOY_REVIEWED_HUMANDOCK_CONTRACTS') throw new MeChainError('REMOTE_DEPLOYMENT_NOT_AUTHORIZED', 'Remote deployment requires explicit reviewed network and deployer authorization');
  }
  if (artifacts.ReviewEscrow.evmVersion !== 'paris' || artifacts.ReleaseRegistry.evmVersion !== 'paris') throw new MeChainError('WRONG_EVM_TARGET', 'Deployment artifacts must target Paris');
  const escrowHash = await wallet.deployContract({ account: wallet.account, chain: client.chain, abi: artifacts.ReviewEscrow.abi as Abi, bytecode: artifacts.ReviewEscrow.bytecode, args: [roles.owner, roles.quoteSigner, roles.assignmentSigner, roles.deliveryGate, roles.arbitrator, roles.platformRecipient, config.quantumWei, input.maxTaskFeeWei] });
  const escrowReceipt = await client.waitForTransactionReceipt({ hash: escrowHash, confirmations: input.confirmations });
  if (escrowReceipt.status !== 'success' || !escrowReceipt.contractAddress) throw new MeChainError('DEPLOYMENT_REVERTED', 'Escrow deployment did not succeed');
  const escrow = escrowReceipt.contractAddress;
  // The escrow deployment is already public if the second transaction fails. Never hide its hash.
  let registryHash: Hex;
  try { registryHash = await wallet.deployContract({ account: wallet.account, chain: client.chain, abi: artifacts.ReleaseRegistry.abi as Abi, bytecode: artifacts.ReleaseRegistry.bytecode, args: [escrow] }); }
  catch (error) { throw new MeChainError('PARTIAL_DEPLOYMENT', `Escrow ${escrow} deployed in ${escrowHash}; registry deployment was not broadcast: ${error instanceof Error ? error.name : 'error'}`); }
  const registryReceipt = await client.waitForTransactionReceipt({ hash: registryHash, confirmations: input.confirmations });
  if (registryReceipt.status !== 'success' || !registryReceipt.contractAddress) throw new MeChainError('PARTIAL_DEPLOYMENT', `Escrow ${escrow} deployed in ${escrowHash}; registry transaction ${registryHash} did not succeed`);
  const registry = registryReceipt.contractAddress;
  const [escrowCode, registryCode] = await Promise.all([client.getBytecode({ address: escrow }), client.getBytecode({ address: registry })]);
  if (!escrowCode || !registryCode) throw new MeChainError('MISSING_CODE', 'Deployment receipt succeeded but contract code is missing');
  const manifest: DeploymentManifest = {
    schema: 'humandock.deployment.v1', chainId: config.chainId, network: config.network,
    escrow, registry, fromBlock: escrowReceipt.blockNumber, confirmations: input.confirmations,
    escrowCodeHash: keccak256(escrowCode), registryCodeHash: keccak256(registryCode), expectedRoles: roles,
    quantumWei: config.quantumWei, maxTaskFeeWei: input.maxTaskFeeWei,
    transactions: { escrow: escrowHash, registry: registryHash },
    compilerVersion: artifacts.ReviewEscrow.compilerVersion, evmVersion: 'paris',
  };
  await verifyDeployment(client, config, manifest);
  return manifest;
}

export const stringifyChainData = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
