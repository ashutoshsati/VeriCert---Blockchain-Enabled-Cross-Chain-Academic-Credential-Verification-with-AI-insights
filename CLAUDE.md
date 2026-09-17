# VeriCert - Cross-Chain Degree Verification

## WHAT: Project Architecture & Stack
*   **Frontend**: Streamlit (Python) for university admin issuance and employer verification UI.
*   **Backend & Database**: Node.js + Express API, MongoDB for local storage and generating SHA-256 credential hashes.
*   **Web3 / Smart Contracts**: Solidity contracts deployed via Remix IDE. 
    *   *Issuer*: `Sender.sol` / `VeriCert.sol` on Polygon Amoy testnet (ChainID 80002).
    *   *Verifier*: `Receiver.sol` on Avalanche Fuji testnet.
    *   *Bridge*: Chainlink CCIP for cross-chain message relay.
*   **AI Layer**: LLM API (Gemini/OpenAI) to analyze Avalanche blockchain logs and generate plain-language trust narratives.

## WHY: Project Purpose
*   Built for the COMP6002 group project, VeriCert ensures degrees cannot be faked or tampered with. 
*   It verifies authenticity by comparing a candidate's presented document hash against the immutable, officially issued cryptographic hash stored on Avalanche Fuji, delivered securely by Chainlink CCIP.

## HOW: Development & Workflow Guidelines
*   **Smart Contract Development**: Test logic in Remix VM first. When deploying to live testnets (Amoy/Fuji), rely on official Chainlink CCIP starter kits rather than writing relay logic from scratch.
*   **Web3 Fallback**: If the CCIP network is slow or testnet funds run out, default to the local mock relay adapter script to prevent bottlenecks in Web2 and AI development.
*   **AI Integration**: When verifying a degree, pass the raw blockchain transaction events from Avalanche directly to the LLM to generate a user-friendly anomaly report and summary. 
*   **Separation of Concerns**: Treat the blockchain layers strictly as a specialized database for storing hashes; all complex data parsing and user interactions must remain in the Web2 and AI layers.