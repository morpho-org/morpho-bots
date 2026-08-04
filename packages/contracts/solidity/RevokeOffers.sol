// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.25;

interface IRevokeOffersMidnight {
    function setConsumed(bytes32 groupId, uint128 amount, address onBehalf) external;
}

/// @notice Revokes multiple Midnight offer groups for the transaction caller.
/// @dev The helper must be authorized on Midnight by each caller before use.
contract RevokeOffers {
    address public immutable MIDNIGHT;

    error ZeroAddress();

    constructor(address midnight) {
        if (midnight == address(0)) revert ZeroAddress();
        MIDNIGHT = midnight;
    }

    /// @notice Marks each offer group as fully consumed for the caller.
    function revokeOffers(bytes32[] calldata groupIds) external {
        for (uint256 i; i < groupIds.length; ++i) {
            IRevokeOffersMidnight(MIDNIGHT).setConsumed(groupIds[i], type(uint128).max, msg.sender);
        }
    }
}
