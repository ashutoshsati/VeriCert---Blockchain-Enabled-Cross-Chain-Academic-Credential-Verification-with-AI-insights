# Deploying VeriCert to the testnets

This puts `VeriCert` on Polygon Amoy and `Receiver` on Avalanche Fuji, connects them, and points the backend at them. Allow about 30–45 minutes the first time, most of it waiting for faucets and CCIP delivery.

## Values you will need

| | Polygon Amoy | Avalanche Fuji |
|---|---|---|
| CCIP Router | `0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2` | `0xF694E193200268f9a4868e4Aa017A0118C9a8177` |
| Chain selector | `16281711391670634445` | `14767482510784806043` |
| Chain ID | 80002 | 43113 |
| Block explorer | https://amoy.polygonscan.com | https://testnet.snowtrace.io |

## 1. Prepare MetaMask

1. Use a MetaMask account that only ever holds testnet tokens.
2. Add both networks (search "Amoy" and "Fuji" on https://chainlist.org with "Include Testnets" ticked, then "Add to MetaMask").
3. Get test tokens:
   - Amoy POL: https://faucet.polygon.technology
   - Fuji AVAX: https://core.app/tools/testnet-faucet (this faucet may require a mainnet AVAX balance or a coupon code; if it does not work, use https://faucets.chain.link/fuji instead)
   About 0.5 POL and 0.5 AVAX is plenty.

## 2. Build the Remix files

```bash
cd contracts
npm install
npm run flatten
```

This creates `contracts/flat/VeriCert.sol` and `contracts/flat/Receiver.sol`.

## 3. Compile in Remix

1. Open https://remix.ethereum.org.
2. Create `VeriCert.sol` and `Receiver.sol` in the file explorer and paste in the contents of the two `flat/` files.
3. In **Solidity compiler**: compiler `0.8.24`, then **Advanced configurations**: tick **Enable optimization** with `200` runs and set **EVM version** to `paris`.
4. Compile both files. There should be no errors.

## 4. Deploy VeriCert on Amoy

1. Switch MetaMask to **Amoy**.
2. In **Deploy & run transactions**, set **Environment** to **Injected Provider - MetaMask**.
3. Select contract `VeriCert`, fill in the constructor:
   - `router_`: `0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2`
   - `destinationChainSelector_`: `14767482510784806043`
4. Click **Deploy** and confirm in MetaMask. Copy the deployed address: this is `VERICERT_ADDRESS`.

## 5. Deploy Receiver on Fuji

1. Switch MetaMask to **Fuji**.
2. Select contract `Receiver`, fill in the constructor:
   - `router_`: `0xF694E193200268f9a4868e4Aa017A0118C9a8177`
   - `allowedSourceChainSelector_`: `16281711391670634445`
3. Deploy and copy the address: this is `RECEIVER_ADDRESS`.

## 6. Connect the contracts

Still on **Fuji**, under the deployed `Receiver`:
- `setAllowedSender` → the `VeriCert` address from step 4.

Switch MetaMask to **Amoy**. To reuse the deployed `VeriCert`, paste its address into **At Address** with `VeriCert` selected. Then:
- `setReceiver` → the `Receiver` address from step 5.
- `addIssuer` → your MetaMask account address (the same wallet whose key goes into `backend/.env`).

## 7. Point the backend at the contracts

In `backend/.env`:

```env
CHAIN_MODE=ccip
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc
ISSUER_PRIVATE_KEY=<your MetaMask private key>
VERICERT_ADDRESS=<from step 4>
RECEIVER_ADDRESS=<from step 5>
```

Use a separate MongoDB database for `CHAIN_MODE=ccip` than for `CHAIN_MODE=mock` (a different database name in `MONGODB_URI`, e.g. `vericert-ccip`) — records created under one mode are not visible in the other, so switching modes against the same database leaves stale records that 404 or stay pending forever.

## 8. Smoke test

```bash
cd backend
npm run smoke:ccip
```

It issues a throwaway test hash, prints the Amoy transaction and a CCIP Explorer link, then checks Fuji every 30 seconds until the record arrives (usually 5–25 minutes).

## Alternative: deploy with one command

Instead of steps 3–6, fill in `contracts/.env` (see `contracts/.env.example`) and run:

```bash
cd contracts
npm run deploy:testnets
```

It prints the two addresses for step 7.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Backend error "not an approved issuer" | `VeriCert.addIssuer` was not called for the wallet in `ISSUER_PRIVATE_KEY` (step 6). |
| Backend error "has no Receiver address set" | `VeriCert.setReceiver` was not called (step 6). |
| "insufficient POL for gas + CCIP fee" | Top up the wallet from the Amoy faucet. |
| CCIP Explorer shows the message as **Failed** on Fuji | Usually `Receiver.setAllowedSender` is missing or wrong (step 6). Fix it, then use **Manual execution** on the message page in CCIP Explorer. |
| Message stuck as **Waiting for finality** for a long time | Normal on testnets during busy periods; `/verify` returns 202 with the message ID until it lands. |
