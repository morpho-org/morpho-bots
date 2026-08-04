// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.25;

import {RevokeOffers} from "../solidity/RevokeOffers.sol";

contract RevokeOffersMidnightMock {
    mapping(address => mapping(bytes32 => uint128)) public consumed;
    mapping(address => mapping(address => bool)) public isAuthorized;

    error Unauthorized();

    function setIsAuthorized(address authorized, bool newIsAuthorized) external {
        isAuthorized[msg.sender][authorized] = newIsAuthorized;
    }

    function setConsumed(bytes32 groupId, uint128 amount, address onBehalf) external {
        if (msg.sender != onBehalf && !isAuthorized[onBehalf][msg.sender]) revert Unauthorized();
        consumed[onBehalf][groupId] = amount;
    }
}

contract RevokeOffersActor {
    function authorize(RevokeOffersMidnightMock midnight, address authorized) external {
        midnight.setIsAuthorized(authorized, true);
    }

    function revoke(RevokeOffers helper, bytes32[] memory groupIds) external {
        helper.revokeOffers(groupIds);
    }
}

contract RevokeOffersTest {
    RevokeOffersMidnightMock midnight;
    RevokeOffers helper;
    RevokeOffersActor maker;

    function setUp() public {
        midnight = new RevokeOffersMidnightMock();
        helper = new RevokeOffers(address(midnight));
        maker = new RevokeOffersActor();
        maker.authorize(midnight, address(helper));
    }

    function testRevokesMultipleGroupsForCaller() public {
        bytes32[] memory groupIds = groups();

        maker.revoke(helper, groupIds);

        require(midnight.consumed(address(maker), groupIds[0]) == type(uint128).max);
        require(midnight.consumed(address(maker), groupIds[1]) == type(uint128).max);
    }

    function testSecondCallerCannotRevokeForFirstCaller() public {
        bytes32[] memory groupIds = groups();
        RevokeOffersActor secondMaker = new RevokeOffersActor();
        secondMaker.authorize(midnight, address(helper));

        secondMaker.revoke(helper, groupIds);

        require(midnight.consumed(address(maker), groupIds[0]) == 0);
        require(midnight.consumed(address(secondMaker), groupIds[0]) == type(uint128).max);
    }

    function testMidnightAuthorizationIsEnforced() public {
        bytes32[] memory groupIds = groups();
        RevokeOffersActor unauthorizedMaker = new RevokeOffersActor();

        (bool success,) = address(unauthorizedMaker).call(abi.encodeCall(unauthorizedMaker.revoke, (helper, groupIds)));

        require(!success);
        require(midnight.consumed(address(unauthorizedMaker), groupIds[0]) == 0);
    }

    function testRejectsZeroMidnightAddress() public {
        (bool success,) = address(this).call(abi.encodeWithSelector(this.deploy.selector));
        require(!success);
    }

    function testExposesBoundMidnight() public view {
        require(helper.MIDNIGHT() == address(midnight));
    }

    function deploy() external returns (RevokeOffers) {
        return new RevokeOffers(address(0));
    }

    function groups() internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](2);
        groupIds[0] = bytes32(uint256(1));
        groupIds[1] = bytes32(uint256(2));
    }
}
