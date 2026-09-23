// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Not deployed anywhere: importing these makes Hardhat compile Chainlink Local's CCIP simulator
// and mock router so tests can deploy them and call MockCCIPRouter.setFee / routeMessage.
import {CCIPLocalSimulator} from "@chainlink/local/src/ccip/CCIPLocalSimulator.sol";
import {MockCCIPRouter} from "@chainlink/local/src/vendor/chainlink-ccip/test/mocks/MockRouter.sol";
