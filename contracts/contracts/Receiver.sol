// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VeriCert Receiver (Avalanche Fuji)
/// @notice Stores credential records relayed from the VeriCert contract on Polygon Amoy via Chainlink CCIP.
/// @dev Implements IAny2EVMMessageReceiver directly instead of extending Chainlink's CCIPReceiver, because
///      CCIPReceiver imports OpenZeppelin contracts v5.0.2 with a path that Hardhat 2 cannot resolve.
contract Receiver is IAny2EVMMessageReceiver, IERC165, Ownable {
    uint8 public constant ACTION_ISSUE = 1;
    uint8 public constant ACTION_REVOKE = 2;

    struct Record {
        address issuer;
        uint64 issuedAt;
        uint64 receivedAt;
        bool revoked;
        bool exists;
    }

    address public immutable router;
    uint64 public immutable allowedSourceChainSelector;
    address public allowedSender;

    mapping(bytes32 => Record) private records;

    event AllowedSenderSet(address indexed sender);
    event CredentialReceived(bytes32 indexed hash, address indexed issuer, uint64 issuedAt, bytes32 messageId);
    event CredentialRevoked(bytes32 indexed hash, bytes32 messageId);

    error ZeroAddress();
    error InvalidRouter(address caller);
    error UnauthorizedSource(uint64 sourceChainSelector, address sender);
    error UnknownAction(uint8 action);

    constructor(address router_, uint64 allowedSourceChainSelector_) Ownable(msg.sender) {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        allowedSourceChainSelector = allowedSourceChainSelector_;
    }

    /// @notice Set to the VeriCert contract address on Amoy after it is deployed.
    function setAllowedSender(address sender) external onlyOwner {
        if (sender == address(0)) revert ZeroAddress();
        allowedSender = sender;
        emit AllowedSenderSet(sender);
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function ccipReceive(Client.Any2EVMMessage calldata message) external override {
        if (msg.sender != router) revert InvalidRouter(msg.sender);

        address sender = abi.decode(message.sender, (address));
        if (message.sourceChainSelector != allowedSourceChainSelector || sender != allowedSender) {
            revert UnauthorizedSource(message.sourceChainSelector, sender);
        }

        (uint8 action, bytes32 hash, address issuer, uint64 issuedAt) =
            abi.decode(message.data, (uint8, bytes32, address, uint64));
        Record storage record = records[hash];

        if (action == ACTION_ISSUE) {
            // Ignore duplicates, including an ISSUE that arrives after its REVOKE.
            if (record.exists) return;
            records[hash] = Record(issuer, issuedAt, uint64(block.timestamp), false, true);
            emit CredentialReceived(hash, issuer, issuedAt, message.messageId);
        } else if (action == ACTION_REVOKE) {
            if (record.revoked) return;
            if (record.exists) {
                record.revoked = true;
            } else {
                // CCIP may deliver out of order: a REVOKE before its ISSUE creates the record already revoked.
                records[hash] = Record(issuer, issuedAt, uint64(block.timestamp), true, true);
            }
            emit CredentialRevoked(hash, message.messageId);
        } else {
            revert UnknownAction(action);
        }
    }

    function getCredential(bytes32 hash)
        external
        view
        returns (bool exists, address issuer, uint64 issuedAt, uint64 receivedAt, bool revoked)
    {
        Record memory record = records[hash];
        return (record.exists, record.issuer, record.issuedAt, record.receivedAt, record.revoked);
    }
}
