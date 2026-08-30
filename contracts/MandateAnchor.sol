// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Evidence-only AP2 mandate anchor. It never authorizes or executes payments.
contract MandateAnchor is AccessControl, Pausable {
    bytes32 public constant ANCHORER_ROLE = keccak256("ANCHORER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    mapping(bytes32 => bool) private anchored;

    event MandateAnchored(
        bytes32 indexed closedCheckoutHash,
        bytes32 indexed closedPaymentHash,
        bytes32 checkoutHash,
        bytes32 transactionIdHash,
        bytes32 agentIdHash,
        bytes32 policyVersionHash,
        uint8 mandateType,
        uint256 timestamp
    );

    constructor(address admin, address pauser, address anchorer) {
        require(admin != address(0) && pauser != address(0) && anchorer != address(0), "zero address");
        require(admin != pauser && admin != anchorer && pauser != anchorer, "roles must be distinct");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(ANCHORER_ROLE, anchorer);
    }

    function anchor(
        bytes32 closedCheckoutHash,
        bytes32 closedPaymentHash,
        bytes32 checkoutHash,
        bytes32 transactionIdHash,
        bytes32 agentIdHash,
        bytes32 policyVersionHash,
        uint8 mandateType
    ) external onlyRole(ANCHORER_ROLE) whenNotPaused {
        require(
            closedCheckoutHash != bytes32(0)
                && closedPaymentHash != bytes32(0)
                && checkoutHash != bytes32(0)
                && transactionIdHash != bytes32(0)
                && agentIdHash != bytes32(0)
                && policyVersionHash != bytes32(0),
            "empty evidence"
        );
        require(!anchored[closedCheckoutHash] && !anchored[closedPaymentHash], "already anchored");
        anchored[closedCheckoutHash] = true;
        anchored[closedPaymentHash] = true;
        emit MandateAnchored(closedCheckoutHash, closedPaymentHash, checkoutHash, transactionIdHash, agentIdHash, policyVersionHash, mandateType, block.timestamp);
    }

    function isAnchored(bytes32 evidenceHash) external view returns (bool) {
        return anchored[evidenceHash];
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }
}
