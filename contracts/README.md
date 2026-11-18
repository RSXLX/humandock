# ReviewEscrow and ReleaseRegistry

These are a working, non-upgradeable MVP implementation with isolated EVM tests. They have **not** been independently audited, deployed to ME, or verified against ME native-asset balance conversion. The application remains in its explicitly labelled demo mode until the integration gates are completed.

## Build and test

```sh
npm run contracts:compile
npm run test:contracts
```

The compiler is pinned to Solidity 0.8.30, OpenZeppelin Contracts 5.4.0, optimizer 200 runs, `viaIR: true`, and `evmVersion: paris`. Compilation produces `contracts/artifacts/*.json` and `packages/me/src/generated-abis.ts`. No deployment or RPC call is performed by compilation. Tests use Ganache's in-process provider; no external blockchain, wallet, or private key is used.

## Immutable deployment configuration

`ReviewEscrow(owner, quoteSigner, assignmentSigner, deliveryGate, arbitrator, platformRecipient, quantumWei, maxTaskFeeWei)`

All authority addresses, the native-asset quantum, and the per-task fee cap are immutable. Choose independently controlled keys for the quote, assignment, delivery gate, arbitration, and owner roles. The owner only controls admission pause; ownership does not permit changing existing obligations, rescuing escrow liabilities, replacing an arbitrator, or upgrading code. A new deployment is required for different monetary units or authority configuration.

All ABI money fields and financial events use **EVM wei**, represented by `uint256` / TypeScript `bigint`. W and P must be exact multiples of `quantumWei`; deposits must equal `W + P` exactly and respect the deployment cap. The candidate ME quantum `10^10` comes from official Ethermint source, not a completed live-network verification. Local tests deliberately use this candidate quantum to exercise nontrivial rounding; Ganache itself does not implement ME's bank conversion.

`ReleaseRegistry(escrowAddress)` holds no money, has no admin override, and cannot call settlement or withdrawals. P0 brand authority is the immutable task buyer. It supports EOA EIP-712 signatures; ERC-1271 contract-wallet approval and delegated brand approvers are not implemented.

## State and deadlines

| State | Actions | Result |
| --- | --- | --- |
| FUNDED | Buyer cancellation; anyone expires after acceptance deadline | CLOSED, full buyer credit |
| FUNDED | Named reviewer consumes assignment permit before acceptance deadline | ASSIGNED |
| ASSIGNED | Reviewer submits gate/reviewer-signed delivery before delivery deadline | SUBMITTED |
| ASSIGNED | Anyone expires an undelivered task at the delivery deadline | CLOSED, full buyer credit |
| SUBMITTED | Buyer accepts service, or anyone settles after 48 hours | CLOSED, W reviewer / P platform |
| SUBMITTED | Buyer disputes before the 48-hour deadline | DISPUTED |
| DISPUTED | Immutable arbitrator decides before 72 hours | CLOSED, W split by alpha; P buyer |
| DISPUTED | Anyone finalizes at/after 72 hours | CLOSED, W split at 5000 bps; P buyer |

Review duration is signed in the quote (1 hour–7 days; the application default is 24 hours). Delivery is due at acceptance block time + review duration. Challenge and arbitration windows start at their respective action's execution block time. Receipts, confirmations, retries, extra evidence, and admission pause never reset a deadline. Signed quote acceptance must be within the next 7 days. Delivery attestations last at most 15 minutes.

The split is `floor((W / q) * alphaBps / 10000) * q`; buyer receives `W + P - reviewerCredit`, platform zero. The timeout split is a disclosed contractual fallback, not a claim of objective fairness. Normal settlement separately credits W/P and zero to buyer. All three report verdicts (`PASS=1`, `CHANGES_REQUIRED=2`, `BLOCK=3`) can complete a paid review service.

Only `createAndFund` and `acceptAssignment` are disabled by admission pause. Existing submission, service acceptance, dispute, arbitration, expiration, settlement and withdrawal paths remain callable. Timeouts require a transaction from a participant or keeper; contracts do not wake themselves up.

## Signatures and delivery trust

Use the exact TypeScript types in `packages/me/src/contracts.ts`, never hand-build an alternative signed payload. Quote, assignment, delivery, approval and revocation each have separate EIP-712 types, chain/contract domains, and consumed nonces. Quotes also enforce `(buyer, clientRequestId)` uniqueness. Old quote signatures remain usable until expiry if unused; there is no onchain quote cancellation in this milestone. Applications must retain the exact signed input snapshot and cannot treat a database-only supersession as an onchain revocation.

An assignment permit binds task ID, task commitment, signed quote digest, buyer, reviewer, task-specific reviewer principal, expiry and nonce. A generic verified-identity credential cannot take another task. Quote and assignment issuers must assign comparable task-specific pseudonyms to the same canonical human; arbitrary wallet-specific aliases cannot prevent self-review. These pseudonyms are not public DIDs or zero-knowledge proofs.

The accepted `DeliveryEnvelope` binds the final salted commitment, plaintext verdict, schema hash and expiry, and requires **both** reviewer and trusted delivery-gate signatures. The gate must validate the unsigned report schema, exact reviewed version, and authorized buyer/arbitrator access to immutable private objects. It is not a semantic quality oracle. Compute the unsigned report hash, final manifest and commitment before signing the external envelope; never include a signature inside its own signed hash dependency.

## Payments and approval are separate

`TaskClosed` credits balances; it does not mean a recipient has withdrawn. `withdrawTo` only withdraws the caller's aggregated credit to the caller's chosen receiver, uses checks/effects/interactions and reentrancy protection, and restores credit if the receiver rejects payment. A `Withdrawal` event intentionally contains no task ID because several tasks can fund one withdrawal.

The invariants are:

```text
totalFundedWei = totalLockedWei + totalClaimableWei + totalWithdrawnWei
contract native balance >= totalLockedWei + totalClaimableWei
```

Forced surplus is not assigned to users. There is no surplus sweep in P0. The registry reads the one accepted final delivery and PASS verdict even while escrow remains SUBMITTED or DISPUTED; payment completion is not an approval prerequisite. Only the task buyer can authorize the exact commitment for `HUMANDOCK_CONTROLLED_EXPORT_V1`. Revocation and expiration invalidate future checked exports. Repeated valid export is permitted without another chain transaction or charge; external downloaded bytes cannot be recalled. An export backend must record its checked block and revalidate the private immutable content, not merely trust a URL.

## Remaining production gates

Verify ME chain ID, current node/build, native currency and bank conversion, quantum, external wallet typed-data support, identity status/KYC mapping, RPC confirmation policy, and a small real deposit/split/withdraw reconciliation. Staff the gate and arbitrator, protect issuer keys, set a low fee cap and allowlist, and review the contracts independently before real-money operation. No deployment script automatically clears these gates.
