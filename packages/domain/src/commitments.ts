import { randomBytes } from 'node:crypto';
import canonicalizeCjs from 'canonicalize';
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';

export function textHash(text: string): Hex { return keccak256(stringToHex(text)); }
export function randomSalt(): Hex { return `0x${randomBytes(32).toString('hex')}`; }
export function canonicalJson(value: unknown): string {
  // canonicalize 2.x ships a CJS function and ESM-shaped declarations.
  const serialize = canonicalizeCjs as unknown as (input: unknown) => string | undefined;
  const result = serialize(value);
  if (result === undefined) throw new Error('Cannot canonicalize undefined');
  return result;
}
export function commitment(kind: 'SOURCE' | 'FINAL', manifest: Record<string, unknown>, salt: string): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [textHash(`HumanDock/${kind}/v1`), textHash(canonicalJson(manifest)), salt as Hex],
  ));
}
