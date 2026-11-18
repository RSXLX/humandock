// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Native-asset review escrow. All amounts, including events, are EVM wei.
/// @dev quantumWei must be verified against the actual target chain BEFORE deployment.
///      This contract is non-upgradeable. Owner can pause admissions, never exits.
contract ReviewEscrow is EIP712, Ownable, ReentrancyGuard {
    enum State { NONE, FUNDED, ASSIGNED, SUBMITTED, DISPUTED, CLOSED }
    enum Verdict { NONE, PASS, CHANGES_REQUIRED, BLOCK }
    enum ClosureReason { NONE, NORMAL, BUYER_CANCELLED, UNASSIGNED_EXPIRED, DELIVERY_EXPIRED, ARBITRATED, ARBITRATION_TIMEOUT }

    struct Quote {
        address buyer;
        bytes32 clientRequestId;
        bytes32 taskCommitment;
        bytes32 buyerPrincipal;
        uint256 reviewerFeeWei;
        uint256 platformFeeWei;
        uint256 quantumWei;
        uint64 acceptUntil;
        uint32 reviewDuration;
        uint64 expiresAt;
        uint256 nonce;
    }

    struct AssignmentPermit {
        uint256 taskId;
        bytes32 taskCommitment;
        bytes32 termsHash;
        address buyer;
        address reviewer;
        bytes32 reviewerPrincipal;
        uint64 expiresAt;
        uint256 nonce;
    }

    // The unsigned private report is hashed BEFORE constructing this envelope.
    // Reviewer/gate signatures are outside that report, preventing circular hashes.
    struct DeliveryEnvelope {
        uint256 taskId;
        bytes32 taskCommitment;
        bytes32 deliveryCommitment;
        address reviewer;
        Verdict verdict;
        bytes32 schemaHash;
        uint64 issuedAt;
        uint64 expiresAt;
        uint256 nonce;
    }

    struct Task {
        address buyer;
        address reviewer;
        bytes32 taskCommitment;
        bytes32 buyerPrincipal;
        bytes32 reviewerPrincipal;
        bytes32 termsHash;
        bytes32 deliveryCommitment;
        bytes32 evidenceCommitment;
        bytes32 decisionCommitment;
        uint256 reviewerFeeWei;
        uint256 platformFeeWei;
        uint64 acceptUntil;
        uint64 acceptedAt;
        uint64 deliveryDue;
        uint64 challengeUntil;
        uint64 arbitrationUntil;
        uint32 reviewDuration;
        State state;
        Verdict verdict;
        ClosureReason closureReason;
    }

    uint256 public constant CHALLENGE_PERIOD = 48 hours;
    uint256 public constant ARBITRATION_PERIOD = 72 hours;
    uint256 public constant MAX_DELIVERY_ATTESTATION_TTL = 15 minutes;
    uint256 public constant MIN_REVIEW_DURATION = 1 hours;
    uint256 public constant MAX_REVIEW_DURATION = 7 days;
    uint256 public constant MAX_ACCEPTANCE_WAIT = 7 days;
    uint256 public constant FALLBACK_ALPHA_BPS = 5000;
    bytes32 public constant DELIVERY_SCHEMA_HASH = keccak256("HumanDockDeliveryV1");

    bytes32 public constant QUOTE_TYPEHASH = keccak256("Quote(address buyer,bytes32 clientRequestId,bytes32 taskCommitment,bytes32 buyerPrincipal,uint256 reviewerFeeWei,uint256 platformFeeWei,uint256 quantumWei,uint64 acceptUntil,uint32 reviewDuration,uint64 expiresAt,uint256 nonce)");
    bytes32 public constant ASSIGNMENT_TYPEHASH = keccak256("AssignmentPermit(uint256 taskId,bytes32 taskCommitment,bytes32 termsHash,address buyer,address reviewer,bytes32 reviewerPrincipal,uint64 expiresAt,uint256 nonce)");
    bytes32 public constant DELIVERY_TYPEHASH = keccak256("DeliveryEnvelope(uint256 taskId,bytes32 taskCommitment,bytes32 deliveryCommitment,address reviewer,uint8 verdict,bytes32 schemaHash,uint64 issuedAt,uint64 expiresAt,uint256 nonce)");

    address public immutable quoteSigner;
    address public immutable assignmentSigner;
    address public immutable deliveryGate;
    address public immutable arbitrator;
    address public immutable platformRecipient;
    uint256 public immutable quantumWei;
    uint256 public immutable maxTaskFeeWei;
    bool public admissionsPaused;
    uint256 public nextTaskId = 1;

    uint256 public totalFundedWei;
    uint256 public totalLockedWei;
    uint256 public totalClaimableWei;
    uint256 public totalWithdrawnWei;
    uint256 public nextWithdrawalId = 1;

    mapping(uint256 => Task) private tasks;
    mapping(address => uint256) public claimableWei;
    mapping(address => mapping(bytes32 => uint256)) public taskByClientRequest;
    mapping(address => mapping(uint256 => bool)) public usedQuoteNonces;
    mapping(address => mapping(uint256 => bool)) public usedAssignmentNonces;
    mapping(address => mapping(uint256 => bool)) public usedDeliveryNonces;

    error InvalidConfiguration();
    error AdmissionsPaused();
    error InvalidAmount();
    error InvalidTime();
    error InvalidCommitment();
    error InvalidSignature();
    error Unauthorized();
    error InvalidState();
    error NonceUsed();
    error DuplicateRequest();
    error InvalidAssignment();
    error InvalidDelivery();
    error InvalidAlpha();
    error NoCredit();
    error TransferFailed();

    event AdmissionsPauseChanged(bool paused);
    event TaskFunded(uint256 indexed taskId, address indexed buyer, bytes32 indexed clientRequestId, bytes32 taskCommitment, bytes32 termsHash, uint256 reviewerFeeWei, uint256 platformFeeWei, uint64 acceptUntil, uint32 reviewDuration);
    event TaskAssigned(uint256 indexed taskId, address indexed reviewer, uint64 acceptedAt, uint64 deliveryDue);
    event DeliverySubmitted(uint256 indexed taskId, bytes32 indexed deliveryCommitment, Verdict verdict, uint64 submittedAt, uint64 challengeUntil);
    event DisputeOpened(uint256 indexed taskId, bytes32 evidenceCommitment, uint64 disputedAt, uint64 arbitrationUntil);
    event TaskClosed(uint256 indexed taskId, ClosureReason reason, uint256 reviewerCreditWei, uint256 platformCreditWei, uint256 buyerCreditWei, bytes32 decisionCommitment);
    // An aggregate withdrawal can cover many tasks and deliberately has no taskId.
    event Withdrawal(uint256 indexed withdrawalId, address indexed beneficiary, address indexed receiver, uint256 amountWei);

    constructor(
        address initialOwner,
        address quoteSigner_,
        address assignmentSigner_,
        address deliveryGate_,
        address arbitrator_,
        address platformRecipient_,
        uint256 quantumWei_,
        uint256 maxTaskFeeWei_
    ) EIP712("HumanDockReviewEscrow", "1") Ownable(initialOwner) {
        if (quoteSigner_ == address(0) || assignmentSigner_ == address(0) || deliveryGate_ == address(0) || arbitrator_ == address(0) || platformRecipient_ == address(0)) revert InvalidConfiguration();
        if (quantumWei_ == 0 || maxTaskFeeWei_ == 0 || maxTaskFeeWei_ % quantumWei_ != 0) revert InvalidConfiguration();
        quoteSigner = quoteSigner_;
        assignmentSigner = assignmentSigner_;
        deliveryGate = deliveryGate_;
        arbitrator = arbitrator_;
        platformRecipient = platformRecipient_;
        quantumWei = quantumWei_;
        maxTaskFeeWei = maxTaskFeeWei_;
    }

    function setAdmissionsPaused(bool paused) external onlyOwner {
        admissionsPaused = paused;
        emit AdmissionsPauseChanged(paused);
    }

    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q)));
    }

    function assignmentDigest(AssignmentPermit calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ASSIGNMENT_TYPEHASH, p)));
    }

    function deliveryDigest(DeliveryEnvelope calldata e) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DELIVERY_TYPEHASH, e)));
    }

    function createAndFund(Quote calldata q, bytes calldata quoteSignature) external payable returns (uint256 taskId) {
        if (admissionsPaused) revert AdmissionsPaused();
        if (msg.sender != q.buyer || q.buyer == arbitrator) revert Unauthorized();
        if (q.taskCommitment == bytes32(0) || q.clientRequestId == bytes32(0) || q.buyerPrincipal == bytes32(0)) revert InvalidCommitment();
        if (q.quantumWei != quantumWei || q.reviewerFeeWei == 0 || q.reviewerFeeWei % quantumWei != 0 || q.platformFeeWei % quantumWei != 0) revert InvalidAmount();
        // Compare to the cap before adding, so malformed quotes cannot overflow.
        if (q.reviewerFeeWei > maxTaskFeeWei || q.platformFeeWei > maxTaskFeeWei - q.reviewerFeeWei) revert InvalidAmount();
        uint256 fee = q.reviewerFeeWei + q.platformFeeWei;
        if (msg.value != fee) revert InvalidAmount();
        if (block.timestamp >= q.expiresAt || q.expiresAt > q.acceptUntil || block.timestamp >= q.acceptUntil || q.acceptUntil > block.timestamp + MAX_ACCEPTANCE_WAIT) revert InvalidTime();
        if (q.reviewDuration < MIN_REVIEW_DURATION || q.reviewDuration > MAX_REVIEW_DURATION) revert InvalidTime();
        if (usedQuoteNonces[q.buyer][q.nonce]) revert NonceUsed();
        if (taskByClientRequest[q.buyer][q.clientRequestId] != 0) revert DuplicateRequest();
        bytes32 termsHash = quoteDigest(q);
        if (ECDSA.recover(termsHash, quoteSignature) != quoteSigner) revert InvalidSignature();
        usedQuoteNonces[q.buyer][q.nonce] = true;
        taskId = nextTaskId++;
        taskByClientRequest[q.buyer][q.clientRequestId] = taskId;
        Task storage t = tasks[taskId];
        t.buyer = q.buyer;
        t.taskCommitment = q.taskCommitment;
        t.buyerPrincipal = q.buyerPrincipal;
        t.termsHash = termsHash;
        t.reviewerFeeWei = q.reviewerFeeWei;
        t.platformFeeWei = q.platformFeeWei;
        t.acceptUntil = q.acceptUntil;
        t.reviewDuration = q.reviewDuration;
        t.state = State.FUNDED;
        totalFundedWei += fee;
        totalLockedWei += fee;
        emit TaskFunded(taskId, q.buyer, q.clientRequestId, q.taskCommitment, termsHash, q.reviewerFeeWei, q.platformFeeWei, q.acceptUntil, q.reviewDuration);
    }

    function acceptAssignment(AssignmentPermit calldata p, bytes calldata assignmentSignature) external {
        if (admissionsPaused) revert AdmissionsPaused();
        Task storage t = tasks[p.taskId];
        if (t.state != State.FUNDED) revert InvalidState();
        if (msg.sender != p.reviewer || msg.sender == t.buyer || msg.sender == arbitrator) revert Unauthorized();
        if (block.timestamp >= t.acceptUntil || block.timestamp >= p.expiresAt || p.expiresAt > t.acceptUntil) revert InvalidTime();
        if (p.buyer != t.buyer || p.taskCommitment != t.taskCommitment || p.termsHash != t.termsHash || p.reviewerPrincipal == bytes32(0) || p.reviewerPrincipal == t.buyerPrincipal) revert InvalidAssignment();
        if (usedAssignmentNonces[p.reviewer][p.nonce]) revert NonceUsed();
        if (ECDSA.recover(assignmentDigest(p), assignmentSignature) != assignmentSigner) revert InvalidSignature();
        usedAssignmentNonces[p.reviewer][p.nonce] = true;
        t.reviewer = p.reviewer;
        t.reviewerPrincipal = p.reviewerPrincipal;
        t.acceptedAt = uint64(block.timestamp);
        t.deliveryDue = uint64(block.timestamp + t.reviewDuration);
        t.state = State.ASSIGNED;
        emit TaskAssigned(p.taskId, p.reviewer, t.acceptedAt, t.deliveryDue);
    }

    function submitDelivery(DeliveryEnvelope calldata e, bytes calldata reviewerSignature, bytes calldata gateSignature) external {
        Task storage t = tasks[e.taskId];
        if (t.state != State.ASSIGNED) revert InvalidState();
        if (msg.sender != t.reviewer || e.reviewer != t.reviewer) revert Unauthorized();
        if (block.timestamp >= t.deliveryDue || block.timestamp >= e.expiresAt || e.issuedAt > block.timestamp || e.issuedAt < t.acceptedAt || e.expiresAt <= e.issuedAt || e.expiresAt - e.issuedAt > MAX_DELIVERY_ATTESTATION_TTL) revert InvalidTime();
        if (e.taskCommitment != t.taskCommitment || e.deliveryCommitment == bytes32(0) || e.schemaHash != DELIVERY_SCHEMA_HASH || e.verdict == Verdict.NONE) revert InvalidDelivery();
        if (usedDeliveryNonces[e.reviewer][e.nonce]) revert NonceUsed();
        bytes32 digest = deliveryDigest(e);
        if (ECDSA.recover(digest, reviewerSignature) != t.reviewer || ECDSA.recover(digest, gateSignature) != deliveryGate) revert InvalidSignature();
        usedDeliveryNonces[e.reviewer][e.nonce] = true;
        t.deliveryCommitment = e.deliveryCommitment;
        t.verdict = e.verdict;
        t.challengeUntil = uint64(block.timestamp + CHALLENGE_PERIOD);
        t.state = State.SUBMITTED;
        emit DeliverySubmitted(e.taskId, e.deliveryCommitment, e.verdict, uint64(block.timestamp), t.challengeUntil);
    }

    function cancelUnassigned(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.FUNDED) revert InvalidState();
        if (msg.sender != t.buyer) revert Unauthorized();
        _close(taskId, ClosureReason.BUYER_CANCELLED, 0, 0);
    }

    function expireUnassigned(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.FUNDED) revert InvalidState();
        if (block.timestamp < t.acceptUntil) revert InvalidTime();
        _close(taskId, ClosureReason.UNASSIGNED_EXPIRED, 0, 0);
    }

    function expireUndelivered(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.ASSIGNED) revert InvalidState();
        if (block.timestamp < t.deliveryDue) revert InvalidTime();
        _close(taskId, ClosureReason.DELIVERY_EXPIRED, 0, 0);
    }

    /// @notice Accepting service immediately ends the buyer's onchain dispute right.
    function acceptService(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.SUBMITTED) revert InvalidState();
        if (msg.sender != t.buyer) revert Unauthorized();
        _close(taskId, ClosureReason.NORMAL, t.reviewerFeeWei, t.platformFeeWei);
    }

    function settleAfterWindow(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.SUBMITTED) revert InvalidState();
        if (block.timestamp < t.challengeUntil) revert InvalidTime();
        _close(taskId, ClosureReason.NORMAL, t.reviewerFeeWei, t.platformFeeWei);
    }

    function openDispute(uint256 taskId, bytes32 evidenceCommitment) external {
        Task storage t = tasks[taskId];
        if (t.state != State.SUBMITTED) revert InvalidState();
        if (msg.sender != t.buyer) revert Unauthorized();
        if (block.timestamp >= t.challengeUntil) revert InvalidTime();
        if (evidenceCommitment == bytes32(0)) revert InvalidCommitment();
        t.evidenceCommitment = evidenceCommitment;
        t.arbitrationUntil = uint64(block.timestamp + ARBITRATION_PERIOD);
        t.state = State.DISPUTED;
        emit DisputeOpened(taskId, evidenceCommitment, uint64(block.timestamp), t.arbitrationUntil);
    }

    function resolveDispute(uint256 taskId, uint256 alphaBps, bytes32 decisionCommitment) external {
        Task storage t = tasks[taskId];
        if (t.state != State.DISPUTED) revert InvalidState();
        if (msg.sender != arbitrator) revert Unauthorized();
        if (block.timestamp >= t.arbitrationUntil) revert InvalidTime();
        if (alphaBps > 10000) revert InvalidAlpha();
        if (decisionCommitment == bytes32(0)) revert InvalidCommitment();
        t.decisionCommitment = decisionCommitment;
        _closeDispute(taskId, ClosureReason.ARBITRATED, alphaBps);
    }

    function finalizeDisputeTimeout(uint256 taskId) external {
        Task storage t = tasks[taskId];
        if (t.state != State.DISPUTED) revert InvalidState();
        if (block.timestamp < t.arbitrationUntil) revert InvalidTime();
        _closeDispute(taskId, ClosureReason.ARBITRATION_TIMEOUT, FALLBACK_ALPHA_BPS);
    }

    function withdrawTo(address payable receiver) external nonReentrant {
        if (receiver == address(0) || receiver == address(this)) revert Unauthorized();
        uint256 amount = claimableWei[msg.sender];
        if (amount == 0) revert NoCredit();
        claimableWei[msg.sender] = 0;
        totalClaimableWei -= amount;
        totalWithdrawnWei += amount;
        uint256 withdrawalId = nextWithdrawalId++;
        (bool ok,) = receiver.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawal(withdrawalId, msg.sender, receiver, amount);
    }

    function getTask(uint256 taskId) external view returns (Task memory) { return tasks[taskId]; }

    /// @notice Exposes accepted content proof independently of settlement state.
    function deliveryProof(uint256 taskId) external view returns (address buyer, address reviewer, bytes32 taskCommitment, bytes32 deliveryCommitment, Verdict verdict, bool submitted) {
        Task storage t = tasks[taskId];
        return (t.buyer, t.reviewer, t.taskCommitment, t.deliveryCommitment, t.verdict, t.deliveryCommitment != bytes32(0));
    }

    function _closeDispute(uint256 taskId, ClosureReason reason, uint256 alphaBps) private {
        uint256 units = tasks[taskId].reviewerFeeWei / quantumWei;
        uint256 reviewerCredit = Math.mulDiv(units, alphaBps, 10000) * quantumWei;
        _close(taskId, reason, reviewerCredit, 0);
    }

    function _close(uint256 taskId, ClosureReason reason, uint256 reviewerCredit, uint256 platformCredit) private {
        Task storage t = tasks[taskId];
        uint256 fee = t.reviewerFeeWei + t.platformFeeWei;
        uint256 buyerCredit = fee - reviewerCredit - platformCredit;
        t.state = State.CLOSED;
        t.closureReason = reason;
        totalLockedWei -= fee;
        totalClaimableWei += fee;
        if (reviewerCredit != 0) claimableWei[t.reviewer] += reviewerCredit;
        if (platformCredit != 0) claimableWei[platformRecipient] += platformCredit;
        if (buyerCredit != 0) claimableWei[t.buyer] += buyerCredit;
        emit TaskClosed(taskId, reason, reviewerCredit, platformCredit, buyerCredit, t.decisionCommitment);
    }
}
