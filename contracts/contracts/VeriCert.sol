// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VeriCert issuer registry (Polygon Amoy)
/// @notice Source of truth for issued credential hashes. Every issue and revoke is relayed to the
///         Receiver contract on Avalanche Fuji through Chainlink CCIP, with the fee paid in native POL.
contract VeriCert is Ownable {
    uint8 public constant ACTION_ISSUE = 1;
    uint8 public constant ACTION_REVOKE = 2;

    struct Record {
        address issuer;
        uint64 issuedAt;
        bool revoked;
        bool exists;
    }

    IRouterClient public immutable router;
    uint64 public immutable destinationChainSelector;
    address public receiver;
    uint256 public gasLimit = 200_000;

    mapping(address => bool) public isIssuer;
    mapping(bytes32 => Record) private records;

    event IssuerAdded(address indexed account);
    event IssuerRemoved(address indexed account);
    event ReceiverSet(address indexed receiver);
    event GasLimitSet(uint256 gasLimit);
    event CredentialIssued(bytes32 indexed hash, address indexed issuer, bytes32 messageId);
    event CredentialRevoked(bytes32 indexed hash, address indexed revokedBy, bytes32 messageId);

    error NotIssuer(address account);
    error ZeroAddress();
    error ReceiverNotSet();
    error AlreadyIssued(bytes32 hash);
    error NotIssued(bytes32 hash);
    error AlreadyRevoked(bytes32 hash);
    error InsufficientFee(uint256 required, uint256 sent);
    error RefundFailed();

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    constructor(address router_, uint64 destinationChainSelector_) Ownable(msg.sender) {
        if (router_ == address(0)) revert ZeroAddress();
        router = IRouterClient(router_);
        destinationChainSelector = destinationChainSelector_;
    }

    function addIssuer(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isIssuer[account] = true;
        emit IssuerAdded(account);
    }

    function removeIssuer(address account) external onlyOwner {
        isIssuer[account] = false;
        emit IssuerRemoved(account);
    }

    /// @notice Set to the Receiver contract address on Fuji after it is deployed.
    function setReceiver(address receiver_) external onlyOwner {
        if (receiver_ == address(0)) revert ZeroAddress();
        receiver = receiver_;
        emit ReceiverSet(receiver_);
    }

    /// @notice Gas available to Receiver.ccipReceive on Fuji.
    function setGasLimit(uint256 gasLimit_) external onlyOwner {
        gasLimit = gasLimit_;
        emit GasLimitSet(gasLimit_);
    }

    /// @notice Records a credential hash and relays it to Fuji. Send at least quoteFee(ACTION_ISSUE, hash) as value.
    function issue(bytes32 hash) external payable onlyIssuer returns (bytes32 messageId) {
        if (records[hash].exists) revert AlreadyIssued(hash);
        Record memory record = Record(msg.sender, uint64(block.timestamp), false, true);
        records[hash] = record;
        messageId = _send(ACTION_ISSUE, hash, record);
        emit CredentialIssued(hash, msg.sender, messageId);
    }

    /// @notice Revokes a credential and relays the revocation to Fuji. Send at least quoteFee(ACTION_REVOKE, hash) as value.
    function revoke(bytes32 hash) external payable onlyIssuer returns (bytes32 messageId) {
        Record storage record = records[hash];
        if (!record.exists) revert NotIssued(hash);
        if (record.revoked) revert AlreadyRevoked(hash);
        record.revoked = true;
        messageId = _send(ACTION_REVOKE, hash, record);
        emit CredentialRevoked(hash, msg.sender, messageId);
    }

    /// @notice CCIP fee in native POL for relaying `action` for `hash`.
    function quoteFee(uint8 action, bytes32 hash) external view returns (uint256) {
        Record memory record = records[hash];
        if (!record.exists) record = Record(msg.sender, uint64(block.timestamp), false, true);
        return router.getFee(destinationChainSelector, _buildMessage(action, hash, record));
    }

    function getCredential(bytes32 hash) external view returns (bool exists, address issuer, uint64 issuedAt, bool revoked) {
        Record memory record = records[hash];
        return (record.exists, record.issuer, record.issuedAt, record.revoked);
    }

    function _send(uint8 action, bytes32 hash, Record memory record) private returns (bytes32 messageId) {
        if (receiver == address(0)) revert ReceiverNotSet();
        Client.EVM2AnyMessage memory message = _buildMessage(action, hash, record);
        uint256 fee = router.getFee(destinationChainSelector, message);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        messageId = router.ccipSend{value: fee}(destinationChainSelector, message);

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Both actions carry the record's original issuer and issue time, so the Receiver can build a
    ///      complete record even if a REVOKE is delivered before its ISSUE.
    function _buildMessage(uint8 action, bytes32 hash, Record memory record)
        private
        view
        returns (Client.EVM2AnyMessage memory)
    {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(receiver),
            data: abi.encode(action, hash, record.issuer, record.issuedAt),
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(0),
            extraArgs: Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: gasLimit, allowOutOfOrderExecution: true}))
        });
    }
}
