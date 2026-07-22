// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.25;
import {
    CrossedBooksResolver,
    CrossedBooksMarket as Market,
    CrossedBooksOffer as Offer,
    CrossedBooksTake as Take
} from "../solidity/CrossedBooksResolver.sol";

interface IBuy {
    function onBuy(bytes32, Market memory, uint256, uint256, uint256, address, bytes memory) external returns (bytes32);
}

contract Token {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract Actor {
    function approve(Token t, address s) external {
        t.approve(s, type(uint256).max);
    }

    function resolve(CrossedBooksResolver resolver, Take[] memory sells, Take[] memory buys, uint256 minProfit)
        external
        returns (uint256)
    {
        return resolver.resolve(sells, buys, minProfit);
    }
}

contract MidnightMock {
    bytes32 constant OK = keccak256("morpho.midnight.callbackSuccess");
    Token immutable token;
    mapping(address => uint256) public credit;

    constructor(Token t) {
        token = t;
    }

    function take(
        Offer memory o,
        bytes memory,
        uint256 units,
        address taker,
        address receiver,
        address callback,
        bytes memory data
    ) external returns (uint256 buyerAssets, uint256 sellerAssets) {
        require(o.market.midnight == address(this));
        require(taker == msg.sender);
        if (o.buy) {
            require(credit[taker] >= units);
            credit[taker] -= units;
            sellerAssets = units * o.tick;
            buyerAssets = sellerAssets;
            require(token.transferFrom(o.maker, receiver, sellerAssets));
            return (buyerAssets, sellerAssets);
        }
        credit[taker] += units;
        buyerAssets = units * o.tick;
        sellerAssets = buyerAssets;
        require(IBuy(callback).onBuy(bytes32(0), o.market, buyerAssets, units, 0, taker, data) == OK);
        require(token.transferFrom(taker, o.receiverIfMakerIsSeller, buyerAssets));
    }
}

contract CrossedBooksResolverTest {
    Token token;
    MidnightMock midnight;
    CrossedBooksResolver resolver;
    Actor askMaker;
    Actor bidMaker;

    function setUp() public {
        token = new Token();
        midnight = new MidnightMock(token);
        resolver = new CrossedBooksResolver(address(midnight));
        askMaker = new Actor();
        bidMaker = new Actor();
        token.mint(address(bidMaker), 1000);
        bidMaker.approve(token, address(midnight));
    }

    function testResolveMultipleOffersRecursively() public {
        (Offer memory ask0, Offer memory bid0) = offers(5, 8);
        (Offer memory ask1, Offer memory bid1) = offers(6, 7);
        ask1.group = bytes32(uint256(3));
        bid1.group = bytes32(uint256(4));
        Take[] memory sells = new Take[](2);
        sells[0] = Take(ask0, "", 10);
        sells[1] = Take(ask1, "", 10);
        Take[] memory buys = new Take[](2);
        buys[0] = Take(bid0, "", 10);
        buys[1] = Take(bid1, "", 10);

        uint256 profit = resolver.resolve(sells, buys, 40);

        require(profit == 40);
        require(token.balanceOf(address(this)) == 40);
        require(token.balanceOf(address(askMaker)) == 110);
        require(token.balanceOf(address(resolver)) == 0);
        require(token.allowance(address(resolver), address(midnight)) == 0);
        require(midnight.credit(address(resolver)) == 0);
    }

    function testResolveReturnsProfitAndNoUnits() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        uint256 profit = resolver.resolve(sells, buys, 20);
        require(profit == 20);
        require(token.balanceOf(address(this)) == 20);
        require(token.balanceOf(address(askMaker)) == 50);
        require(token.balanceOf(address(resolver)) == 0);
        require(midnight.credit(address(resolver)) == 0);
    }

    function testResolveIsPermissionlessAndPaysCaller() public {
        Actor caller = new Actor();
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        uint256 profit = caller.resolve(resolver, sells, buys, 20);
        require(profit == 20);
        require(token.balanceOf(address(caller)) == 20);
        require(token.balanceOf(address(resolver)) == 0);
    }

    function testPreservesPreexistingBalance() public {
        token.mint(address(resolver), 3);
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        resolver.resolve(sells, buys, 20);
        require(token.balanceOf(address(resolver)) == 3);
    }

    function testRevertsBelowMinimumProfitAtomically() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 6, 10);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 11)));
        require(!ok);
        require(token.balanceOf(address(askMaker)) == 0);
        require(midnight.credit(address(resolver)) == 0);
    }

    function testRevertsWhenProfitIsZeroEvenWithZeroMinimum() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 5, 10);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
        require(token.balanceOf(address(askMaker)) == 0);
        require(midnight.credit(address(resolver)) == 0);
    }

    function testRejectsEmptyOfferArrays() public {
        Take[] memory sells = new Take[](0);
        Take[] memory buys = new Take[](0);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
    }

    function testRejectsZeroUnits() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 0);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
    }

    function testRejectsUnbalancedUnits() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        buys[0].units = 9;
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
    }

    function testDoesNotUsePreexistingBalanceToSubsidizeUnprofitableCross() public {
        token.mint(address(resolver), 100);
        (Take[] memory sells, Take[] memory buys) = plan(5, 4, 10);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
        require(token.balanceOf(address(resolver)) == 100);
        require(token.balanceOf(address(askMaker)) == 0);
    }

    function testConsumesTheExactMidnightAllowance() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        resolver.resolve(sells, buys, 20);
        require(token.allowance(address(resolver), address(midnight)) == 0);
    }

    function testRejectsWrongSides() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        sells[0].offer.buy = true;
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
    }

    function testRejectsDifferentMarkets() public {
        (Take[] memory sells, Take[] memory buys) = plan(5, 7, 10);
        buys[0].offer.market.loanToken = address(0xdead);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.resolve, (sells, buys, 0)));
        require(!ok);
    }

    function testRejectsCallbackOutsideActiveResolution() public {
        (Offer memory ask,) = offers(5, 7);
        (bool ok,) = address(resolver)
            .call(abi.encodeCall(resolver.onBuy, (bytes32(0), ask.market, 50, 10, 0, address(resolver), bytes(""))));
        require(!ok);
    }

    function plan(uint256 a, uint256 b, uint256 units) internal view returns (Take[] memory sells, Take[] memory buys) {
        (Offer memory ask, Offer memory bid) = offers(a, b);
        sells = new Take[](1);
        sells[0] = Take(ask, "", units);
        buys = new Take[](1);
        buys[0] = Take(bid, "", units);
    }

    function offers(uint256 a, uint256 b) internal view returns (Offer memory ask, Offer memory bid) {
        Market memory m;
        m.chainId = block.chainid;
        m.midnight = address(midnight);
        m.loanToken = address(token);
        m.maturity = block.timestamp + 1 days;
        ask = Offer(
            m,
            false,
            address(askMaker),
            0,
            type(uint256).max,
            a,
            bytes32(uint256(1)),
            address(0),
            "",
            address(askMaker),
            address(1),
            false,
            type(uint128).max,
            0,
            type(uint256).max
        );
        bid = Offer(
            m,
            true,
            address(bidMaker),
            0,
            type(uint256).max,
            b,
            bytes32(uint256(2)),
            address(0),
            "",
            address(0),
            address(1),
            false,
            type(uint128).max,
            0,
            type(uint256).max
        );
    }
}
