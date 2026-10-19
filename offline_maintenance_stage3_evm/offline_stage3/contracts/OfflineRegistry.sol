// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Trusted bridge registry. Does NOT verify Ed25519, physical actions or true execution time.
contract OfflineRegistry {
    address public immutable owner;
    uint256 public totalRecords;
    uint256 public totalConflicts;

    struct LeaseInput {
        bytes32 sessionId;
        address submitter;
        bytes32 robot;
        bytes32 workOrder;
        uint64 version;
        uint64 issuedAt;
        uint64 expiresAt;
        uint32 quota;
        bytes32 grantHash;
    }
    struct Lease {
        LeaseInput policy;
        uint32 count;
        bytes32 lastHash;
        bool exists;
    }
    struct RecordInput {
        bytes32 sessionId;
        uint32 sequence;
        bytes32 previousHash;
        bytes32 recordHash;
        bytes32 requestId;
        bytes32 robot;
        bytes32 workOrder;
        uint64 version;
        bytes32 operation;
        uint64 executedAt;
    }
    struct Entry { bytes32 recordHash; bytes32 metadataHash; bool exists; }
    mapping(bytes32 => Lease) private leases;
    mapping(bytes32 => mapping(bytes32 => bool)) public allowedOperations;
    mapping(bytes32 => mapping(uint32 => Entry)) public entries;
    mapping(bytes32 => mapping(bytes32 => bool)) private usedRequests;
    mapping(bytes32 => bool) private observedConflicts;

    event LeaseRegistered(bytes32 indexed sessionId, address indexed submitter, bytes32 grantHash);
    event RecordAccepted(bytes32 indexed sessionId, uint32 indexed sequence, bytes32 recordHash);
    event DuplicateObserved(bytes32 indexed sessionId, uint32 indexed sequence, bytes32 recordHash);
    event ConflictObserved(bytes32 indexed sessionId, uint32 indexed sequence, bytes32 originalHash,
                           bytes32 incomingHash, bytes32 incomingMetadataHash);

    constructor() { owner = msg.sender; }

    function registerLease(LeaseInput calldata policy, bytes32[] calldata operations) external {
        require(msg.sender == owner, "OWNER_ONLY");
        require(!leases[policy.sessionId].exists, "LEASE_EXISTS");
        require(policy.submitter != address(0) && policy.quota > 0, "BAD_POLICY");
        require(policy.expiresAt > policy.issuedAt && operations.length > 0, "BAD_POLICY");
        leases[policy.sessionId].policy = policy;
        leases[policy.sessionId].exists = true;
        for (uint256 i; i < operations.length; ++i) {
            allowedOperations[policy.sessionId][operations[i]] = true;
        }
        emit LeaseRegistered(policy.sessionId, policy.submitter, policy.grantHash);
    }

    // 0 accepted, 1 duplicate, 2 observed conflict. First accepted entry is never overwritten.
    function submit(RecordInput calldata record) external returns (uint8) {
        Lease storage lease = leases[record.sessionId];
        require(lease.exists, "UNKNOWN_LEASE");
        require(msg.sender == lease.policy.submitter, "SUBMITTER_ONLY");
        require(record.robot == lease.policy.robot && record.workOrder == lease.policy.workOrder
                && record.version == lease.policy.version, "BAD_SCOPE");
        require(allowedOperations[record.sessionId][record.operation], "BAD_OPERATION");
        // Deliberately checks declared execution time, not current upload/block time.
        require(record.executedAt >= lease.policy.issuedAt && record.executedAt < lease.policy.expiresAt,
                "BAD_DECLARED_TIME");
        require(record.recordHash != bytes32(0) && record.requestId != bytes32(0), "BAD_HASH");
        bytes32 metadataHash = keccak256(abi.encode(record));
        Entry storage old = entries[record.sessionId][record.sequence];
        if (old.exists) {
            if (old.recordHash == record.recordHash && old.metadataHash == metadataHash) {
                emit DuplicateObserved(record.sessionId, record.sequence, record.recordHash);
                return 1;
            }
            bytes32 conflictKey = keccak256(abi.encode(record.sessionId, record.sequence,
                                                       record.recordHash, metadataHash));
            if (!observedConflicts[conflictKey]) {
                observedConflicts[conflictKey] = true;
                ++totalConflicts;
                emit ConflictObserved(record.sessionId, record.sequence, old.recordHash,
                                      record.recordHash, metadataHash);
            }
            return 2;
        }
        require(record.sequence == lease.count + 1, "SEQUENCE_GAP");
        require(record.sequence <= lease.policy.quota, "QUOTA_EXHAUSTED");
        require(record.previousHash == lease.lastHash, "BAD_PREVIOUS_HASH");
        require(!usedRequests[record.sessionId][record.requestId], "REQUEST_REUSED");
        usedRequests[record.sessionId][record.requestId] = true;
        old.recordHash = record.recordHash;
        old.metadataHash = metadataHash;
        old.exists = true;
        lease.count = record.sequence;
        lease.lastHash = record.recordHash;
        ++totalRecords;
        emit RecordAccepted(record.sessionId, record.sequence, record.recordHash);
        return 0;
    }

    function leaseState(bytes32 sessionId) external view returns (uint32 count, bytes32 lastHash, bool exists) {
        Lease storage lease = leases[sessionId];
        return (lease.count, lease.lastHash, lease.exists);
    }
}
