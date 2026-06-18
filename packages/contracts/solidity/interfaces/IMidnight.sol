// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

// Interface that reproduces the ABI of the deployed Base Midnight
// (0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854), i.e. `morpho-org/midnight@main`'s
// `src/interfaces/IMidnight.sol` at the deployed revision (solc 0.8.35). Structs are file-level so
// the generated ABI carries `internalType: "struct Market"` (not `"struct IMidnight.Market"`). The
// MidnightAbi.equiv.test.ts deep-equal against the frozen snapshot is authoritative: keep this in
// sync with that oracle, NOT with the (newer, drifted) prime-monorepo copy.

struct CollateralParams {
    address token;
    uint256 lltv;
    uint256 maxLif;
    address oracle;
}

struct Market {
    address loanToken;
    CollateralParams[] collateralParams;
    uint256 maturity;
    uint256 rcfThreshold;
    address enterGate;
    address liquidatorGate;
}

struct Offer {
    Market market;
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
    uint256 maxUnits;
    uint256 maxAssets;
}

interface IMidnight {
    error AlreadyConsumed();
    error BuyerGatedFromIncreasingCredit();
    error CannotIncreaseDebtPostMaturity();
    error CollateralParamsNotSorted();
    error ConsumedAssets();
    error ConsumedUnits();
    error ContinuousFeeTooHigh();
    error FeeNotMultipleOfFeeCbp();
    error InconsistentInput();
    error InvalidFeeIndex();
    error InvalidMaxLif();
    error InvalidOfferCaps();
    error InvalidTickSpacing();
    error LiquidatorGatedFromLiquidating();
    error LltvNotAllowed();
    error MakerCreditOrDebtIncreased();
    error MarketLossFactorMaxedOut();
    error MarketNotCreated();
    error MaturityTooFar();
    error NoCollateralParams();
    error NotBorrower();
    error NotLiquidatable();
    error OfferExpired();
    error OfferNotStarted();
    error OnlyFeeClaimer();
    error OnlyFeeSetter();
    error OnlyRoleSetter();
    error OnlyTickSpacingSetter();
    error RatifierFail();
    error RatifierUnauthorized();
    error RecoveryCloseFactorConditionsViolated();
    error SelfTake();
    error SellerGatedFromIncreasingDebt();
    error SellerIsLiquidatable();
    error SettlementFeeTooHigh();
    error TakerUnauthorized();
    error TickNotAccessible();
    error TooManyActivatedCollaterals();
    error TooManyCollateralParams();
    error Unauthorized();
    error UnhealthyBorrower();
    error UnusedReceiverMustBeZero();
    error WrongBuyCallbackReturnValue();
    error WrongFlashLoanCallbackReturnValue();
    error WrongLiquidateCallbackReturnValue();
    error WrongRepayCallbackReturnValue();
    error WrongSellCallbackReturnValue();

    event UpdatePosition(
        bytes32 indexed id_,
        address indexed user,
        uint256 creditDecrease,
        uint256 pendingFeeDecrease,
        uint256 accruedFee
    );

    function INITIAL_CHAIN_ID() external view returns (uint256);

    function claimContinuousFee(Market memory market, uint256 amount, address receiver) external;

    function claimSettlementFee(address token, uint256 amount, address receiver) external;

    function claimableSettlementFee(address token) external view returns (uint256);

    function collateral(bytes32 id, address user, uint256 index) external view returns (uint128);

    function collateralBitmap(bytes32 id, address user) external view returns (uint128);

    function consumed(address user, bytes32 group) external view returns (uint256);

    function continuousFee(bytes32 id) external view returns (uint32);

    function continuousFeeCredit(bytes32 id) external view returns (uint128);

    function creditOf(bytes32 id, address user) external view returns (uint128);

    function debtOf(bytes32 id, address user) external view returns (uint128);

    function defaultContinuousFee(address loanToken) external view returns (uint32);

    function defaultSettlementFeeCbp(address loanToken, uint256 index) external view returns (uint16);

    function feeClaimer() external view returns (address);

    function feeSetter() external view returns (address);

    function flashLoan(address[] memory tokens, uint256[] memory assets, address callback, bytes memory data) external;

    function isAuthorized(address authorizer, address authorized) external view returns (bool);

    function isHealthy(Market memory market, bytes32 id, address borrower) external view returns (bool);

    function lastAccrual(bytes32 id, address user) external view returns (uint128);

    function lastLossFactor(bytes32 id, address user) external view returns (uint128);

    function liquidate(
        Market memory market,
        uint256 collateralIndex,
        uint256 seizedAssets,
        uint256 repaidUnits,
        address borrower,
        bool postMaturityMode,
        address receiver,
        address callback,
        bytes memory data
    ) external returns (uint256, uint256);

    function liquidationLocked(bytes32 id, address user) external view returns (bool);

    function lossFactor(bytes32 id) external view returns (uint128);

    function marketState(bytes32 id)
        external
        view
        returns (
            uint128 totalUnits,
            uint128 lossFactor,
            uint128 withdrawable,
            uint128 continuousFeeCredit,
            uint16 settlementFeeCbp0,
            uint16 settlementFeeCbp1,
            uint16 settlementFeeCbp2,
            uint16 settlementFeeCbp3,
            uint16 settlementFeeCbp4,
            uint16 settlementFeeCbp5,
            uint16 settlementFeeCbp6,
            uint32 continuousFee,
            uint8 tickSpacing
        );

    function multicall(bytes[] memory calls) external;

    function pendingFee(bytes32 id, address user) external view returns (uint128);

    function position(bytes32 id, address user)
        external
        view
        returns (
            uint128 credit,
            uint128 pendingFee,
            uint128 lastLossFactor,
            uint128 lastAccrual,
            uint128 debt,
            uint128 collateralBitmap
        );

    function repay(Market memory market, uint256 units, address onBehalf, address callback, bytes memory data) external;

    function roleSetter() external view returns (address);

    function setConsumed(bytes32 group, uint256 amount, address onBehalf) external;

    function setDefaultContinuousFee(address loanToken, uint256 newContinuousFee) external;

    function setDefaultSettlementFee(address loanToken, uint256 index, uint256 newSettlementFee) external;

    function setFeeClaimer(address newFeeClaimer) external;

    function setFeeSetter(address newFeeSetter) external;

    function setIsAuthorized(address authorized, bool newIsAuthorized, address onBehalf) external;

    function setMarketContinuousFee(bytes32 id, uint256 newContinuousFee) external;

    function setMarketSettlementFee(bytes32 id, uint256 index, uint256 newSettlementFee) external;

    function setMarketTickSpacing(bytes32 id, uint256 newTickSpacing) external;

    function setRoleSetter(address newRoleSetter) external;

    function setTickSpacingSetter(address newTickSpacingSetter) external;

    function settlementFee(bytes32 id, uint256 timeToMaturity) external view returns (uint256);

    function settlementFeeCbps(bytes32 id) external view returns (uint16[7] memory);

    function supplyCollateral(Market memory market, uint256 collateralIndex, uint256 assets, address onBehalf) external;

    function take(
        Offer memory offer,
        bytes memory ratifierData,
        uint256 units,
        address taker,
        address receiverIfTakerIsSeller,
        address takerCallback,
        bytes memory takerCallbackData
    ) external returns (uint256, uint256);

    function tickSpacing(bytes32 id) external view returns (uint8);

    function tickSpacingSetter() external view returns (address);

    function toId(Market memory market) external view returns (bytes32);

    function toMarket(bytes32 id) external view returns (Market memory);

    function totalUnits(bytes32 id) external view returns (uint128);

    function touchMarket(Market memory market) external returns (bytes32);

    function updatePosition(Market memory market, address user) external returns (uint128, uint128, uint128);

    function updatePositionView(Market memory market, bytes32 id, address user)
        external
        view
        returns (uint128, uint128, uint128);

    function withdraw(Market memory market, uint256 units, address onBehalf, address receiver) external;

    function withdrawCollateral(
        Market memory market,
        uint256 collateralIndex,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;

    function withdrawable(bytes32 id) external view returns (uint128);
}
