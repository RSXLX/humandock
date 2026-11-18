// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IReviewEscrow {
    function deliveryProof(uint256 taskId) external view returns (address buyer, address reviewer, bytes32 taskCommitment, bytes32 deliveryCommitment, uint8 verdict, bool submitted);
}

/// @notice Explicit brand approval for a single exact PASS delivery. Holds no funds.
/// @dev P0 brand authority is the task buyer. EOA signatures only in this MVP.
contract ReleaseRegistry is EIP712 {
    struct ApprovalIntent {
        address escrow;
        uint256 taskId;
        address brandAuthority;
        bytes32 deliveryCommitment;
        bytes32 purposeHash;
        uint64 expiresAt;
        uint256 nonce;
    }
    struct RevocationIntent {
        bytes32 approvalId;
        address brandAuthority;
        uint64 expiresAt;
        uint256 nonce;
    }
    struct Approval {
        uint256 taskId;
        address brandAuthority;
        bytes32 deliveryCommitment;
        bytes32 purposeHash;
        uint64 approvedAt;
        uint64 expiresAt;
        bool revoked;
    }

    bytes32 public constant EXPORT_PURPOSE_HASH = keccak256("HUMANDOCK_CONTROLLED_EXPORT_V1");
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("ApprovalIntent(address escrow,uint256 taskId,address brandAuthority,bytes32 deliveryCommitment,bytes32 purposeHash,uint64 expiresAt,uint256 nonce)");
    bytes32 public constant REVOCATION_TYPEHASH = keccak256("RevocationIntent(bytes32 approvalId,address brandAuthority,uint64 expiresAt,uint256 nonce)");
    IReviewEscrow public immutable escrow;
    mapping(bytes32 => Approval) private approvals;
    mapping(address => mapping(uint256 => bool)) public usedApprovalNonces;
    mapping(address => mapping(uint256 => bool)) public usedRevocationNonces;

    error InvalidConfiguration();
    error InvalidApproval();
    error InvalidSignature();
    error InvalidTime();
    error NonceUsed();
    event ReleaseApproved(bytes32 indexed approvalId, uint256 indexed taskId, address indexed brandAuthority, bytes32 deliveryCommitment, bytes32 purposeHash, uint64 expiresAt);
    event ReleaseRevoked(bytes32 indexed approvalId, address indexed brandAuthority);

    constructor(address escrow_) EIP712("HumanDockReleaseRegistry", "1") {
        if (escrow_ == address(0) || escrow_.code.length == 0) revert InvalidConfiguration();
        escrow = IReviewEscrow(escrow_);
    }

    function approvalDigest(ApprovalIntent calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, a)));
    }
    function revocationDigest(RevocationIntent calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVOCATION_TYPEHASH, r)));
    }

    /// @dev A relayer may submit the brand's signed exact intent, never change it.
    function approve(ApprovalIntent calldata a, bytes calldata brandSignature) external returns (bytes32 approvalId) {
        if (a.escrow != address(escrow) || a.purposeHash != EXPORT_PURPOSE_HASH) revert InvalidApproval();
        if (block.timestamp >= a.expiresAt) revert InvalidTime();
        (address buyer,,,bytes32 commitment,uint8 verdict,bool submitted) = escrow.deliveryProof(a.taskId);
        if (!submitted || verdict != 1 || buyer != a.brandAuthority || commitment != a.deliveryCommitment) revert InvalidApproval();
        if (usedApprovalNonces[buyer][a.nonce]) revert NonceUsed();
        approvalId = approvalDigest(a);
        if (ECDSA.recover(approvalId, brandSignature) != buyer) revert InvalidSignature();
        usedApprovalNonces[buyer][a.nonce] = true;
        approvals[approvalId] = Approval(a.taskId, buyer, commitment, a.purposeHash, uint64(block.timestamp), a.expiresAt, false);
        emit ReleaseApproved(approvalId, a.taskId, buyer, commitment, a.purposeHash, a.expiresAt);
    }

    function revoke(RevocationIntent calldata r, bytes calldata brandSignature) external {
        Approval storage a = approvals[r.approvalId];
        if (a.brandAuthority == address(0) || a.revoked || r.brandAuthority != a.brandAuthority) revert InvalidApproval();
        if (block.timestamp >= r.expiresAt) revert InvalidTime();
        if (usedRevocationNonces[r.brandAuthority][r.nonce]) revert NonceUsed();
        if (ECDSA.recover(revocationDigest(r), brandSignature) != a.brandAuthority) revert InvalidSignature();
        usedRevocationNonces[r.brandAuthority][r.nonce] = true;
        a.revoked = true;
        emit ReleaseRevoked(r.approvalId, r.brandAuthority);
    }

    function getApproval(bytes32 approvalId) external view returns (Approval memory) { return approvals[approvalId]; }

    /// @notice Reusable approval; each export must also verify its immutable private blob.
    /// @dev Read at a recorded block. This cannot make an external download atomic with revocation.
    function isValidApproval(bytes32 approvalId, bytes32 expectedDeliveryCommitment, bytes32 expectedPurposeHash) external view returns (bool) {
        Approval storage a = approvals[approvalId];
        if (a.brandAuthority == address(0) || a.revoked || block.timestamp >= a.expiresAt || a.deliveryCommitment != expectedDeliveryCommitment || a.purposeHash != expectedPurposeHash) return false;
        (address buyer,,,bytes32 commitment,uint8 verdict,bool submitted) = escrow.deliveryProof(a.taskId);
        return submitted && verdict == 1 && buyer == a.brandAuthority && commitment == a.deliveryCommitment;
    }
}
