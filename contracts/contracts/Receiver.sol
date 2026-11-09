// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// =====================================================================================================
// IN PLAIN ENGLISH
// -----------------------------------------------------------------------------------------------------
// This is the "public copy" of the degree register. It lives on the Avalanche Fuji test blockchain.
//
// - It receives messages sent by the VeriCert contract on Polygon Amoy (via Chainlink CCIP, the trusted
//   "postal service" between blockchains) saying "this degree was issued" or "this degree was revoked".
// - It only accepts messages that come through Chainlink AND from our own VeriCert contract on Amoy.
//   Anything else is rejected, so nobody can sneak a fake degree into this copy.
// - Employers' verification checks are answered from here: our backend looks up a degree's
//   fingerprint (hash) and sees whether it exists and whether it has been revoked.
// =====================================================================================================

// Ready-made building blocks from Chainlink and OpenZeppelin (well-audited standard code).
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VeriCert Receiver (Avalanche Fuji)
/// @notice Stores credential records relayed from the VeriCert contract on Polygon Amoy via Chainlink CCIP.
/// @dev Implements IAny2EVMMessageReceiver directly instead of extending Chainlink's CCIPReceiver, because
///      CCIPReceiver imports OpenZeppelin contracts v5.0.2 with a path that Hardhat 2 cannot resolve.
// "Ownable" means one wallet (whoever deployed it) is the administrator, who sets which sender to trust.
contract Receiver is IAny2EVMMessageReceiver, IERC165, Ownable {
    // The two kinds of message we expect: "a degree was issued" or "a degree was revoked".
    uint8 public constant ACTION_ISSUE = 1;
    uint8 public constant ACTION_REVOKE = 2;

    // What we remember about each degree: issuing university, when it was issued (on Amoy), when the
    // news arrived here, whether it has been revoked, and whether it exists at all.
    struct Record {
        address issuer;
        uint64 issuedAt;
        uint64 receivedAt;
        bool revoked;
        bool exists;
    }

    // Who we trust:
    // - router: Chainlink's "post office" on Fuji. Only it may deliver messages to us.
    // - allowedSourceChainSelector: Chainlink's ID number for the blockchain messages must come from (Amoy).
    // - allowedSender: our VeriCert contract's address on Amoy. Messages from anyone else are refused.
    address public immutable router;
    uint64 public immutable allowedSourceChainSelector;
    address public allowedSender;

    // The register itself: degree fingerprint -> what we know about that degree.
    mapping(bytes32 => Record) private records;

    // Public announcements written to the blockchain's permanent log, readable by anyone.
    event AllowedSenderSet(address indexed sender);
    event CredentialReceived(bytes32 indexed hash, address indexed issuer, uint64 issuedAt, bytes32 messageId);
    event CredentialRevoked(bytes32 indexed hash, bytes32 messageId);

    // The reasons a message can be refused. When refused, nothing is changed.
    error ZeroAddress();
    error InvalidRouter(address caller);
    error UnauthorizedSource(uint64 sourceChainSelector, address sender);
    error UnknownAction(uint8 action);

    // Runs once, when the contract is first put on the blockchain: records the Chainlink post office and
    // which blockchain to accept messages from, and makes the deployer the administrator.
    constructor(address router_, uint64 allowedSourceChainSelector_) Ownable(msg.sender) {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        allowedSourceChainSelector = allowedSourceChainSelector_;
    }

    /// @notice Set to the VeriCert contract address on Amoy after it is deployed.
    // Administrator only: tells this contract which sender on Amoy to trust (our VeriCert contract).
    function setAllowedSender(address sender) external onlyOwner {
        if (sender == address(0)) revert ZeroAddress();
        allowedSender = sender;
        emit AllowedSenderSet(sender);
    }

    // A standard "can you receive Chainlink messages?" check. Chainlink asks this before delivering.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // THE MAILBOX. Chainlink calls this when a message from Amoy arrives.
    function ccipReceive(Client.Any2EVMMessage calldata message) external override {
        // Security check 1: the delivery must come from the real Chainlink post office.
        if (msg.sender != router) revert InvalidRouter(msg.sender);

        // Security check 2: the message must come from Amoy and from our own VeriCert contract.
        address sender = abi.decode(message.sender, (address));
        if (message.sourceChainSelector != allowedSourceChainSelector || sender != allowedSender) {
            revert UnauthorizedSource(message.sourceChainSelector, sender);
        }

        // Open the letter: issue or revoke, which degree, which university, and when it was issued.
        (uint8 action, bytes32 hash, address issuer, uint64 issuedAt) =
            abi.decode(message.data, (uint8, bytes32, address, uint64));
        Record storage record = records[hash];

        if (action == ACTION_ISSUE) {
            // "A degree was issued": add it to the register (unless we already have it) and announce it.
            // Ignore duplicates, including an ISSUE that arrives after its REVOKE.
            if (record.exists) return;
            records[hash] = Record(issuer, issuedAt, uint64(block.timestamp), false, true);
            emit CredentialReceived(hash, issuer, issuedAt, message.messageId);
        } else if (action == ACTION_REVOKE) {
            // "A degree was revoked": mark it as cancelled (unless it already is) and announce it.
            if (record.revoked) return;
            if (record.exists) {
                record.revoked = true;
            } else {
                // CCIP may deliver out of order: a REVOKE before its ISSUE creates the record already revoked.
                records[hash] = Record(issuer, issuedAt, uint64(block.timestamp), true, true);
            }
            emit CredentialRevoked(hash, message.messageId);
        } else {
            // Any other kind of message is not something we understand, so refuse it.
            revert UnknownAction(action);
        }
    }

    // READ-ONLY LOOKUP (free; changes nothing). This is what the backend calls when an employer verifies
    // a degree: does it exist, who issued it, when, when did the news arrive here, and is it revoked?
    function getCredential(bytes32 hash)
        external
        view
        returns (bool exists, address issuer, uint64 issuedAt, uint64 receivedAt, bool revoked)
    {
        Record memory record = records[hash];
        return (record.exists, record.issuer, record.issuedAt, record.receivedAt, record.revoked);
    }
}
