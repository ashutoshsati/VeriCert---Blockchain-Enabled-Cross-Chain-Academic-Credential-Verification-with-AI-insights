# VeriCert Web3 Layer — Design Spec

Date: 2026-09-17
Status: Draft, awaiting review

## Goal

Replace the mock blockchain in the backend with real smart contracts: an issuer contract on Polygon Amoy that relays credential hashes and revocations to a receiver contract on Avalanche Fuji via Chainlink CCIP. Keep the mock as a switchable fallback.

## Decisions

| Topic | Decision |
|---|---|
| Architecture | Option A: `VeriCert.sol` on Amoy (source of truth + CCIP sender), `Receiver.sol` on Fuji (verified copy) |
| Toolchain | Hardhat 2.29.x (ethers v6, mocha/chai via hardhat-toolbox) for development and tests; Remix + MetaMask as the primary deployment path; Hardhat deploy script as backup |
| Libraries | `@chainlink/local@0.2.9`, `@chainlink/contracts-ccip@1.6.2` (the version Chainlink Local is built against), `@openzeppelin/contracts@5.x`; Solidity `0.8.24` |
| Signer | The team's MetaMask account (testnet-only). Its private key lives in `backend/.env`; the backend signs issue/revoke transactions |
| CCIP fees | Paid in native POL, sent with each transaction (`payable`); contract refunds any excess and holds no balance |
| Revocation rights | Any approved issuer may revoke any credential |
| Promotion to `active` | Lazy: happens when `/verify` finds the record on Fuji |
| Revocation in transit | Fail closed: `/verify` reports `isValid: false, revocationPending: true` |

## Network constants (verified against docs.chain.link, 2026-09-17)

| | Polygon Amoy | Avalanche Fuji |
|---|---|---|
| CCIP Router | `0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2` | `0xF694E193200268f9a4868e4Aa017A0118C9a8177` |
| Chain selector | `16281711391670634445` | `14767482510784806043` |
| Chain ID | 80002 | 43113 |

The Amoy → Fuji lane is listed as supported on the Amoy directory page.

## 1. Contracts

### `VeriCert.sol` (Polygon Amoy)

- Inherits OpenZeppelin `Ownable`. Owner = deploying wallet.
- `mapping(address => bool) isIssuer`; `addIssuer(address)` / `removeIssuer(address)` are `onlyOwner` and emit `IssuerAdded` / `IssuerRemoved`.
- Owner-set configuration: `receiver` (Fuji `Receiver` address), `destinationChainSelector`, `gasLimit` (default 200,000). Router address and destination selector are constructor arguments; `setReceiver(address)` and `setGasLimit(uint256)` are `onlyOwner`.
- Storage: `mapping(bytes32 => Record)` where `Record { address issuer; uint64 issuedAt; bool revoked; bool exists; }`.
- `issue(bytes32 hash) payable` — `onlyIssuer`; reverts `AlreadyIssued` if the hash exists and `ReceiverNotSet` if no receiver is configured. Stores the record, sends CCIP message, emits `CredentialIssued(bytes32 indexed hash, address indexed issuer, bytes32 messageId)`.
- `revoke(bytes32 hash) payable` — `onlyIssuer`; reverts `NotIssued` or `AlreadyRevoked`. Marks revoked, sends CCIP message, emits `CredentialRevoked(bytes32 indexed hash, address indexed revokedBy, bytes32 messageId)`.
- `quoteFee(uint8 action, bytes32 hash) view returns (uint256)` — builds the same message and asks the router for the native fee.
- `getCredential(bytes32 hash) view returns (bool exists, address issuer, uint64 issuedAt, bool revoked)`.
- Fee handling: reverts `InsufficientFee(required, sent)` when `msg.value` is too low; refunds `msg.value - fee` to `msg.sender` after sending, reverting `RefundFailed` if the transfer fails.
- Message: `data = abi.encode(uint8 action, bytes32 hash, address issuer, uint64 issuedAt)`, `action` is `1 = ISSUE`, `2 = REVOKE`. Both actions carry the record's original `issuer` and `issuedAt` (not the revoking wallet), so `Receiver` can create a complete record from a REVOKE that arrives first. `feeToken = address(0)` (native). `extraArgs` = `EVMExtraArgsV1{gasLimit}`. No token transfers.
- Custom errors throughout (cheaper and decodable by the backend).

### `Receiver.sol` (Avalanche Fuji)

- Inherits Chainlink `CCIPReceiver` (only the router can call `ccipReceive`) and OpenZeppelin `Ownable`.
- Owner-set allow-list: `allowedSourceChainSelector` (constructor) and `allowedSender` (`setAllowedSender(address)`, set after `VeriCert` is deployed).
- `_ccipReceive` reverts `UnauthorizedSource(selector, sender)` unless both match.
- Storage: `mapping(bytes32 => Record)` where `Record { address issuer; uint64 issuedAt; uint64 receivedAt; bool revoked; bool exists; }`.
- ISSUE: if the hash does not exist, store it (`receivedAt = block.timestamp`) and emit `CredentialReceived(bytes32 indexed hash, address indexed issuer, uint64 issuedAt, bytes32 messageId)`. If it exists, do nothing (idempotent, and never un-revokes).
- REVOKE: create the record if missing (with the issuer/timestamp from the message), set `revoked = true`, emit `CredentialRevoked(bytes32 indexed hash, bytes32 messageId)`. Handles a revoke arriving before its issue.
- Unknown action value: revert `UnknownAction(action)`.
- `getCredential(bytes32 hash) view returns (bool exists, address issuer, uint64 issuedAt, uint64 receivedAt, bool revoked)`.

### Out of scope

Automatic message retries (CCIP Explorer manual execution covers failed deliveries), pausing, upgradeability, per-issuer revocation rights, multi-university ownership, LINK fee payment.

## 2. Backend integration

### Layout

```
backend/chain/index.js   picks implementation from CHAIN_MODE (mock | ccip, default mock)
backend/chain/mock.js    current chain.js, unchanged behaviour
backend/chain/ccip.js    ethers v6 implementation against the deployed contracts
```

`server.js` keeps `require("./chain")`; both implementations export `issueAndRelay(hash, issuer)`, `verifyOnChain(hash)`, `revokeAndRelay(hash)` with the existing return shapes.

### `chain/ccip.js`

- Env: `AMOY_RPC_URL`, `FUJI_RPC_URL`, `ISSUER_PRIVATE_KEY`, `VERICERT_ADDRESS`, `RECEIVER_ADDRESS`. In `ccip` mode the server refuses to start if any is missing (same style as the existing startup check).
- ABIs are human-readable ethers fragments inside the file; a backend test compares them with the Hardhat artifacts.
- `issueAndRelay(hash, issuer)` (the `issuer` name argument is ignored; on-chain the issuer is the signing wallet):
  1. Read `VeriCert.getCredential(hash)`. If it already exists (earlier attempt succeeded but the response was lost), find the `CredentialIssued` log for that hash and return its `txHash` and `messageId` without sending again.
  2. Otherwise `quoteFee(ISSUE, hash)`, add 10%, send `issue(hash, { value })`, wait for 1 confirmation, parse `CredentialIssued` from the receipt.
- `revokeAndRelay(hash)`: same pattern with `revoke`, using `revoked` flag and `CredentialRevoked` logs for recovery.
- `verifyOnChain(hash)`: read `Receiver.getCredential(hash)` on Fuji; map to `{ found, isValid: exists && !revoked, issuer, issuedAt, receivedAt, revoked }` with timestamps in milliseconds (matching the mock). `issuer` is the issuer wallet address.
- Errors: decode custom errors into readable messages (`NotIssuer` → "backend wallet is not an approved issuer", insufficient funds → "wallet has insufficient POL for gas + CCIP fee", etc.) and throw; routes return 500 as today.

### Status lifecycle

`pending` → `relaying` → `active` → `revoked` (add `relaying` to the schema enum).

- `/issue`: create as `pending` (as today). After `issueAndRelay` returns, set `relaying` and log a `relayed` event (`chain: "polygon-amoy"`, with `txHash` and `ccipMessageId`). Response includes `status: "relaying"`. A `pending` record retries on re-issue; a `relaying`/`active`/`revoked` record returns 409.
- `/verify` (GET by hash and POST by document) — decision order:
  1. Fuji has the record → 200 with chain data. If the DB status is `relaying`, set `active` and log a `delivered` event (`chain: "avalanche-fuji"`). If the DB status is `revoked` but Fuji is not yet revoked, return `isValid: false, revocationPending: true`.
  2. Fuji lacks it but DB status is `relaying` → 202 `{ status: "relaying", credentialHash, ccipMessageId, message }`.
  3. Otherwise → 404.
- `/revoke`: allowed when status is `relaying` or `active`; 409 for `pending` or `revoked`. Chain first, then DB, as today.
- Mock mode goes through the same lifecycle; its delivery is instant, so the first verify promotes to `active`.

### Env additions (`backend/.env.example`)

`CHAIN_MODE`, `AMOY_RPC_URL`, `FUJI_RPC_URL`, `ISSUER_PRIVATE_KEY`, `VERICERT_ADDRESS`, `RECEIVER_ADDRESS`, with comments explaining where each comes from and a warning to use a testnet-only wallet.

## 3. Testing and deployment

### Layout

```
contracts/
  contracts/VeriCert.sol
  contracts/Receiver.sol
  contracts/test/          test-only helpers (e.g. a router mock that charges a fixed fee)
  test/                    mocha/chai tests
  scripts/deploy.js        backup deployment + wiring script
  scripts/flatten.js       writes flat/VeriCert.sol and flat/Receiver.sol for Remix
  DEPLOYMENT.md
  hardhat.config.js        networks: hardhat, localhost, amoy, fuji
```

### Contract tests (`contracts/`, `npm test`)

Using `CCIPLocalSimulator` (both contracts use the simulator's single chain selector; delivery is instant):

- Issue on `VeriCert` → record stored, event emitted, record present on `Receiver`.
- Revoke → revoked on both.
- Only issuers can issue/revoke; only owner can manage issuers and configuration.
- Duplicate issue, revoke of unknown hash, and double revoke revert with the right errors.
- `Receiver` rejects wrong source chain selector and wrong sender.
- REVOKE delivered before ISSUE leaves the record revoked.
- Fees: with a test router that charges a fixed fee, underpaying reverts `InsufficientFee` and overpaying refunds the difference.

### Backend tests (`backend/`, `npm test`)

- Existing API tests updated for the new lifecycle (mock mode), plus: 202 while relaying, promotion to `active`, `revocationPending`.
- ABI check: fragments in `chain/ccip.js` match `contracts/artifacts`.
- End-to-end ccip mode: start a Hardhat node, deploy the simulator and both contracts, point both RPC URLs at it, run issue → verify → revoke → verify through the API, plus the "already sent" recovery path. Requires contracts compiled first (the test skips with a clear message if artifacts are missing).

### Deployment (`contracts/DEPLOYMENT.md`, run by the team)

1. Fund the MetaMask account with Amoy POL and Fuji AVAX from the faucets.
2. `npm run flatten`; in Remix, compile `flat/VeriCert.sol` (0.8.24) and deploy on Amoy with the Amoy router and Fuji selector.
3. Deploy `flat/Receiver.sol` on Fuji with the Fuji router and Amoy selector.
4. Wire up: `Receiver.setAllowedSender(VeriCert)`, `VeriCert.setReceiver(Receiver)`, `VeriCert.addIssuer(backend wallet)`.
5. Put addresses in `backend/.env`, set `CHAIN_MODE=ccip`.
6. `npm run smoke:ccip` (backend): issues a throwaway test credential, prints the CCIP Explorer link, polls Fuji until delivered, then verifies.

Backup: `npx hardhat run scripts/deploy.js` performs steps 2–4 using `contracts/.env` (`AMOY_RPC_URL`, `FUJI_RPC_URL`, `DEPLOYER_PRIVATE_KEY`) and prints the addresses.

### Docs

Update `CLAUDE.md` with the `chain/` layout, `CHAIN_MODE` switch, and the `contracts/` project.

## Done when

- All contract tests and backend tests pass locally.
- `DEPLOYMENT.md`, the Hardhat deploy script, and `smoke:ccip` are ready for the team to run on the live testnets (requires their wallet and faucet funds; not run as part of implementation).
