// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.25;

struct CrossedBooksCollateralParams {
    address token;
    uint256 lltv;
    uint256 liquidationCursor;
    address oracle;
}

struct CrossedBooksMarket {
    uint256 chainId;
    address midnight;
    address loanToken;
    CrossedBooksCollateralParams[] collateralParams;
    uint256 maturity;
    uint256 rcfThreshold;
    address enterGate;
    address liquidatorGate;
}

struct CrossedBooksOffer {
    CrossedBooksMarket market;
    bool buy;
    address maker;
    uint256 start;
    uint256 expiry;
    uint256 tick;
    bytes32 group;
    address callback;
    bytes callbackData;
    address receiverIfMakerIsSeller;
    address ratifier;
    bool reduceOnly;
    uint128 maxUnits;
    uint128 maxAssets;
    uint256 continuousFeeCap;
}

interface ICrossedBooksMidnight {
    function take(CrossedBooksOffer memory, bytes memory, uint256, address, address, address, bytes memory)
        external
        returns (uint256 buyerAssets, uint256 sellerAssets);
}

interface ICrossedBooksToken {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @notice Atomically crosses one resting Midnight ask against one resting bid.
/// @dev Permissionless. The ask credits this contract before onBuy; onBuy sells the same units into
/// the bid, whose proceeds fund the outer ask. The positive loan-token balance delta goes to caller.
contract CrossedBooksResolver {
    bytes32 public constant CALLBACK_SUCCESS = keccak256("morpho.midnight.callbackSuccess");
    address public immutable MIDNIGHT;
    bool private resolving;
    bytes32 private activeMarketHash;
    uint256 private activeUnits;

    error InactiveCallback();
    error InsufficientProfit(uint256 profit, uint256 minimum);
    error InvalidMarket();
    error InvalidSides();
    error InvalidUnits();
    error NotCrossed(uint256 buyProceeds, uint256 sellCost);
    error ReentrantCall();
    error TokenCallFailed();
    error UnauthorizedCallback();
    error UnexpectedBuyer();
    error UnexpectedUnits();
    error ZeroAddress();
    event Resolve(
        address indexed caller,
        bytes32 indexed marketHash,
        bytes32 indexed askGroup,
        bytes32 bidGroup,
        uint256 units,
        uint256 profit
    );

    constructor(address midnight) {
        if (midnight == address(0)) revert ZeroAddress();
        MIDNIGHT = midnight;
    }

    function resolve(
        CrossedBooksOffer calldata ask,
        bytes calldata askRatifierData,
        CrossedBooksOffer calldata bid,
        bytes calldata bidRatifierData,
        uint256 units,
        uint256 minimumProfit
    ) external returns (uint256 profit) {
        if (resolving) revert ReentrantCall();
        if (units == 0) revert InvalidUnits();
        if (ask.buy || !bid.buy) revert InvalidSides();
        bytes32 marketHash = keccak256(abi.encode(ask.market));
        if (
            ask.market.midnight != MIDNIGHT || bid.market.midnight != MIDNIGHT
                || marketHash != keccak256(abi.encode(bid.market))
        ) revert InvalidMarket();

        ICrossedBooksToken token = ICrossedBooksToken(ask.market.loanToken);
        uint256 beforeBalance = token.balanceOf(address(this));
        resolving = true;
        activeMarketHash = marketHash;
        activeUnits = units;
        ICrossedBooksMidnight(MIDNIGHT)
            .take(
                ask, askRatifierData, units, address(this), address(0), address(this), abi.encode(bid, bidRatifierData)
            );
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance) revert NotCrossed(afterBalance, beforeBalance);
        profit = afterBalance - beforeBalance;
        if (profit < minimumProfit) revert InsufficientProfit(profit, minimumProfit);
        activeMarketHash = bytes32(0);
        activeUnits = 0;
        _callOptional(address(token), abi.encodeCall(token.transfer, (msg.sender, profit)));
        resolving = false;
        emit Resolve(msg.sender, marketHash, ask.group, bid.group, units, profit);
    }

    function onBuy(
        bytes32,
        CrossedBooksMarket calldata market,
        uint256 buyerAssets,
        uint256 units,
        uint256,
        address buyer,
        bytes calldata data
    ) external returns (bytes32) {
        if (msg.sender != MIDNIGHT) revert UnauthorizedCallback();
        if (!resolving) revert InactiveCallback();
        if (buyer != address(this)) revert UnexpectedBuyer();
        if (units != activeUnits) revert UnexpectedUnits();
        if (keccak256(abi.encode(market)) != activeMarketHash) revert InvalidMarket();
        (CrossedBooksOffer memory bid, bytes memory ratifierData) = abi.decode(data, (CrossedBooksOffer, bytes));
        if (!bid.buy || keccak256(abi.encode(bid.market)) != activeMarketHash) revert InvalidMarket();
        (, uint256 proceeds) = ICrossedBooksMidnight(MIDNIGHT)
            .take(bid, ratifierData, units, address(this), address(this), address(0), bytes(""));
        if (proceeds < buyerAssets) revert NotCrossed(proceeds, buyerAssets);
        ICrossedBooksToken token = ICrossedBooksToken(market.loanToken);
        _callOptional(address(token), abi.encodeCall(token.approve, (MIDNIGHT, 0)));
        _callOptional(address(token), abi.encodeCall(token.approve, (MIDNIGHT, buyerAssets)));
        return CALLBACK_SUCCESS;
    }

    function _callOptional(address target, bytes memory data) internal {
        (bool success, bytes memory returned) = target.call(data);
        if (!success || (returned.length != 0 && !abi.decode(returned, (bool)))) revert TokenCallFailed();
    }
}
