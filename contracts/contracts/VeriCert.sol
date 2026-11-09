// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// =====================================================================================================
// IN PLAIN ENGLISH
// -----------------------------------------------------------------------------------------------------
// This is the "official register" of degrees. It lives on the Polygon Amoy test blockchain.
//
// - A university (an approved "issuer" wallet) records a degree here by storing its fingerprint
//   (a "hash": a short code calculated from the degree's details; change one letter of the degree and
//   the fingerprint changes completely). The student's personal details are never stored on-chain.
// - A university can also cancel ("revoke") a degree it issued.
// - Every time a degree is issued or revoked, this contract sends a message to a second contract
//   (Receiver.sol) on a different blockchain, Avalanche Fuji, using Chainlink CCIP. CCIP is a trusted
//   "postal service" between blockchains. Employers check degrees against that Fuji copy.
// - Sending a message costs a fee, paid in POL (Polygon's own currency) by the wallet making the request.
//   Anything paid above the exact fee is refunded.
//
// Once something is written to a blockchain it cannot be edited or deleted, which is why a degree
// recorded here cannot be quietly faked or altered later.
// =====================================================================================================

// Ready-made building blocks from Chainlink (cross-chain messaging) and OpenZeppelin (well-audited
// standard code for ownership). Reusing them is safer than writing our own.
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title VeriCert issuer registry (Polygon Amoy)
/// @notice Source of truth for issued credential hashes. Every issue and revoke is relayed to the
///         Receiver contract on Avalanche Fuji through Chainlink CCIP, with the fee paid in native POL.
// "Ownable" means one wallet (whoever deployed the contract) is the administrator. Only the
// administrator can approve universities or change settings.
contract VeriCert is Ownable {
    // The two kinds of message we send to Fuji: "a degree was issued" or "a degree was revoked".
    uint8 public constant ACTION_ISSUE = 1;
    uint8 public constant ACTION_REVOKE = 2;

    // What we remember about each degree: which university issued it, when, whether it has been
    // cancelled, and whether it exists at all.
    struct Record {
        address issuer;
        uint64 issuedAt;
        bool revoked;
        bool exists;
    }

    // Settings fixed when the contract is created:
    // - router: Chainlink's "post office" on Amoy that carries messages to other blockchains.
    // - destinationChainSelector: Chainlink's ID number for the destination blockchain (Avalanche Fuji).
    IRouterClient public immutable router;
    uint64 public immutable destinationChainSelector;
    // The address of our Receiver contract on Fuji (the "delivery address" for every message).
    address public receiver;
    // How much computing effort the Receiver is allowed to spend processing each message on Fuji.
    uint256 public gasLimit = 200_000;

    // The list of approved universities (wallet address -> approved yes/no).
    mapping(address => bool) public isIssuer;
    // The register itself: degree fingerprint -> what we know about that degree.
    mapping(bytes32 => Record) private records;

    // "Events" are public announcements written to the blockchain's permanent log. Anyone (including
    // our backend) can read them later to see exactly what happened and when.
    event IssuerAdded(address indexed account);
    event IssuerRemoved(address indexed account);
    event ReceiverSet(address indexed receiver);
    event GasLimitSet(uint256 gasLimit);
    event CredentialIssued(bytes32 indexed hash, address indexed issuer, bytes32 messageId);
    event CredentialRevoked(bytes32 indexed hash, address indexed revokedBy, bytes32 messageId);

    // The reasons a request can be refused. When one of these happens, the whole request is cancelled
    // and nothing is changed.
    error NotIssuer(address account);
    error ZeroAddress();
    error ReceiverNotSet();
    error AlreadyIssued(bytes32 hash);
    error NotIssued(bytes32 hash);
    error AlreadyRevoked(bytes32 hash);
    error InsufficientFee(uint256 required, uint256 sent);
    error RefundFailed();

    // A gatekeeper: any function marked "onlyIssuer" refuses to run unless the caller is an
    // approved university.
    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotIssuer(msg.sender);
        _;
    }

    // Runs once, when the contract is first put on the blockchain. It records the Chainlink post office
    // and the destination blockchain, and makes the deployer the administrator.
    constructor(address router_, uint64 destinationChainSelector_) Ownable(msg.sender) {
        if (router_ == address(0)) revert ZeroAddress();
        router = IRouterClient(router_);
        destinationChainSelector = destinationChainSelector_;
    }

    // ---------------------------------------------------------------------------------------------
    // ADMINISTRATOR ACTIONS (only the contract owner can call these)
    // ---------------------------------------------------------------------------------------------

    // Approve a university's wallet so it can issue and revoke degrees.
    function addIssuer(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isIssuer[account] = true;
        emit IssuerAdded(account);
    }

    // Remove a university's approval. Degrees it already issued stay on record.
    function removeIssuer(address account) external onlyOwner {
        isIssuer[account] = false;
        emit IssuerRemoved(account);
    }

    /// @notice Set to the Receiver contract address on Fuji after it is deployed.
    // Tells this contract where to send its messages on Fuji. Done once, after both contracts exist.
    function setReceiver(address receiver_) external onlyOwner {
        if (receiver_ == address(0)) revert ZeroAddress();
        receiver = receiver_;
        emit ReceiverSet(receiver_);
    }

    /// @notice Gas available to Receiver.ccipReceive on Fuji.
    // Adjusts how much processing effort each message may use on Fuji (a technical tuning knob).
    function setGasLimit(uint256 gasLimit_) external onlyOwner {
        gasLimit = gasLimit_;
        emit GasLimitSet(gasLimit_);
    }

    // ---------------------------------------------------------------------------------------------
    // UNIVERSITY ACTIONS (only approved issuers can call these)
    // ---------------------------------------------------------------------------------------------

    /// @notice Records a credential hash and relays it to Fuji. Send at least quoteFee(ACTION_ISSUE, hash) as value.
    // ISSUE A DEGREE: refuses if this exact degree is already on record, otherwise records it (who issued
    // it and when), sends the news to Fuji, and announces it publicly. Returns the message's tracking number.
    function issue(bytes32 hash) external payable onlyIssuer returns (bytes32 messageId) {
        if (records[hash].exists) revert AlreadyIssued(hash);
        Record memory record = Record(msg.sender, uint64(block.timestamp), false, true);
        records[hash] = record;
        messageId = _send(ACTION_ISSUE, hash, record);
        emit CredentialIssued(hash, msg.sender, messageId);
    }

    /// @notice Revokes a credential and relays the revocation to Fuji. Send at least quoteFee(ACTION_REVOKE, hash) as value.
    // REVOKE A DEGREE: refuses if the degree was never issued or is already revoked, otherwise marks it
    // as cancelled, sends the news to Fuji, and announces it publicly. The record is kept, not deleted,
    // so there is always a history of what happened.
    function revoke(bytes32 hash) external payable onlyIssuer returns (bytes32 messageId) {
        Record storage record = records[hash];
        if (!record.exists) revert NotIssued(hash);
        if (record.revoked) revert AlreadyRevoked(hash);
        record.revoked = true;
        messageId = _send(ACTION_REVOKE, hash, record);
        emit CredentialRevoked(hash, msg.sender, messageId);
    }

    // ---------------------------------------------------------------------------------------------
    // READ-ONLY LOOKUPS (free to call; they change nothing)
    // ---------------------------------------------------------------------------------------------

    /// @notice CCIP fee in native POL for relaying `action` for `hash`.
    // "How much would it cost to send this message?" Lets us check the fee before spending anything.
    function quoteFee(uint8 action, bytes32 hash) external view returns (uint256) {
        Record memory record = records[hash];
        if (!record.exists) record = Record(msg.sender, uint64(block.timestamp), false, true);
        return router.getFee(destinationChainSelector, _buildMessage(action, hash, record));
    }

    // Look up a degree by its fingerprint: does it exist, who issued it, when, and is it revoked?
    function getCredential(bytes32 hash) external view returns (bool exists, address issuer, uint64 issuedAt, bool revoked) {
        Record memory record = records[hash];
        return (record.exists, record.issuer, record.issuedAt, record.revoked);
    }

    // ---------------------------------------------------------------------------------------------
    // INTERNAL HELPERS (used only by this contract)
    // ---------------------------------------------------------------------------------------------

    // Sends one message to Fuji: checks we know where to send it, works out the fee, makes sure the
    // caller paid enough POL, hands the message and exactly that fee to the Chainlink post office, then
    // refunds any overpayment. Returns the tracking number Chainlink gives the message.
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
    // Packs the "letter" for Chainlink: who it's addressed to (our Receiver), what's inside (issue or
    // revoke, the degree fingerprint, the issuing university and the issue time), and that the fee is
    // paid in POL. Messages may arrive in any order, so each one carries everything Fuji needs.
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
