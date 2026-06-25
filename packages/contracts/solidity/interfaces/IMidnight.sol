// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025 Morpho Association
//
// VENDORED verbatim from prime-monorepo packages/contracts/solidity/interfaces/IMidnight.sol (the
// canonical morpho-org/midnight interface). The deployed Base Midnight
// (0x3726353bCDDba7c29a17D46D8a35D1E8b2E51854) emits exactly these events (verified on-chain) and
// exposes these function signatures (identical to the prior vendored copy except 3 unused admin
// setters). The prior copy declared ONLY `UpdatePosition`, which is a fee/credit-accrual event — not
// the borrow event — so event-based borrower discovery was broken; see TIB Amendment §13. (This
// supersedes the prior header's "keep in sync with the frozen snapshot, NOT prime-monorepo" note: no
// such snapshot test exists, and the canonical copy matches the deployed contract's emitted events.)
// Structs are file-level so the generated ABI carries internalType "struct Market" (not
// "struct IMidnight.Market"). Regenerate the ABI with `bun run --filter @repo/contracts build`.
pragma solidity >=0.5.0;

struct Market {
    address loanToken;
    CollateralParams[] collateralParams;
    uint256 maturity;
    uint256 rcfThreshold;
    address enterGate;
    address liquidatorGate;
}

struct CollateralParams {
    address token;
    uint256 lltv;
    uint256 maxLif;
    address oracle;
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
    uint256 maxAssets; // buyerAssets if offer.buy else sellerAssets
}

/// @dev Settlement fee cbp values and the continuous fee are 0 until the market is created, then set to the default
/// values.
struct MarketState {
    uint128 totalUnits;
    uint128 lossFactor;
    uint128 withdrawable;
    uint128 continuousFeeCredit;
    uint16 settlementFeeCbp0;
    uint16 settlementFeeCbp1;
    uint16 settlementFeeCbp2;
    uint16 settlementFeeCbp3;
    uint16 settlementFeeCbp4;
    uint16 settlementFeeCbp5;
    uint16 settlementFeeCbp6;
    uint32 continuousFee;
    uint8 tickSpacing;
}

struct Position {
    uint128 credit;
    uint128 pendingFee;
    uint128 lastLossFactor;
    uint128 lastAccrual;
    uint128 debt;
    uint128 collateralBitmap;
    uint128[128] collateral;
}

interface IMidnight {
    /// EVENTS ///
    // Mirrors the events emitted by EventsLib in the protocol source so the
    // generated MidnightAbi exposes them for log decoding (the app consumes
    // them via getAbiItem(MidnightAbi, '<EventName>') in @repo/resolvers).
    event MarketCreated(Market market, bytes32 indexed id_);
    event Take(
        address caller,
        bytes32 indexed id_,
        uint256 units,
        address indexed taker,
        address indexed maker,
        bool offerIsBuy,
        bytes32 group,
        uint256 buyerAssets,
        uint256 sellerAssets,
        uint256 consumed,
        uint256 buyerPendingFeeIncrease,
        uint256 sellerPendingFeeDecrease,
        uint256 buyerCreditIncrease,
        uint256 sellerCreditDecrease,
        address receiver,
        address payer
    );
    event Withdraw(
        address caller,
        bytes32 indexed id_,
        uint256 units,
        address indexed onBehalf,
        address indexed receiver,
        uint256 pendingFeeDecrease
    );
    event Repay(
        address indexed caller, bytes32 indexed id_, uint256 units, address indexed onBehalf, address payer
    );
    event SupplyCollateral(
        address caller, bytes32 indexed id_, address indexed collateral, uint256 assets, address indexed onBehalf
    );
    event WithdrawCollateral(
        address caller,
        bytes32 indexed id_,
        address indexed collateral,
        uint256 assets,
        address indexed onBehalf,
        address receiver
    );
    event Liquidate(
        address caller,
        bytes32 indexed id_,
        address indexed collateral,
        uint256 seizedAssets,
        uint256 repaidUnits,
        address indexed borrower,
        bool postMaturityMode,
        address receiver,
        address payer,
        uint256 badDebt,
        uint256 latestLossFactor,
        uint256 latestContinuousFeeCredit
    );
    event FlashLoan(address indexed caller, address[] tokens, uint256[] assets, address indexed callback);

    /// ERRORS ///
    error AlreadyConsumed();
    error BuyerGatedFromIncreasingCredit();
    error CannotIncreaseDebtPostMaturity();
    error CollateralParamsNotSorted();
    error CollateralPerUserExceeded();
    error ConsumedAssets();
    error ConsumedUnits();
    error ContinuousFeeTooHigh();
    error FeeNotMultipleOfFeeCbp();
    error InconsistentInput();
    error WrongBuyCallbackReturnValue();
    error WrongSellCallbackReturnValue();
    error WrongRepayCallbackReturnValue();
    error WrongLiquidateCallbackReturnValue();
    error WrongFlashLoanCallbackReturnValue();
    error InvalidFeeIndex();
    error InvalidMaxLif();
    error InvalidTickSpacing();
    error LiquidatorGatedFromLiquidating();
    error LltvNotAllowed();
    error MakerCreditOrDebtIncreased();
    error MaturityTooFar();
    error MaxTakeableAssetsExceeded();
    error MaxTotalUnitsExceeded();
    error MultipleNonZero();
    error NoCollateralParams();
    error NotBorrower();
    error NotLiquidatable();
    error MarketLossFactorMaxedOut();
    error MarketNotCreated();
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
    error TakerUnauthorized();
    error TickNotAccessible();
    error TooManyActivatedCollaterals();
    error TooManyCollateralParams();
    error SettlementFeeTooHigh();
    error Unauthorized();
    error UnhealthyBorrower();

    // forgefmt: disable-start
    /// IMMUTABLES ///
    function INITIAL_CHAIN_ID() external view returns (uint256);

    /// STORAGE GETTERS ///
    function position(bytes32 id, address user) external view returns (uint128 credit, uint128 pendingFee, uint128 lastLossFactor, uint128 lastAccrual, uint128 debt, uint128 collateralBitmap);
    function marketState(bytes32 id) external view returns (uint128 totalUnits, uint128 lossFactor, uint128 withdrawable, uint128 continuousFeeCredit, uint16 settlementFeeCbp0, uint16 settlementFeeCbp1, uint16 settlementFeeCbp2, uint16 settlementFeeCbp3, uint16 settlementFeeCbp4, uint16 settlementFeeCbp5, uint16 settlementFeeCbp6, uint32 continuousFee, uint8 tickSpacing);
    function consumed(address user, bytes32 group) external view returns (uint256);
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function defaultSettlementFeeCbp(address loanToken, uint256 index) external view returns (uint16);
    function defaultContinuousFee(address loanToken) external view returns (uint32);
    function claimableSettlementFee(address token) external view returns (uint256);
    function roleSetter() external view returns (address);
    function feeSetter() external view returns (address);
    function feeClaimer() external view returns (address);
    function tickSpacingSetter() external view returns (address);

    /// MULTICALL ///
    function multicall(bytes[] memory calls) external;

    /// ADMIN FUNCTIONS ///
    function setRoleSetter(address newRoleSetter) external;
    function setFeeSetter(address newFeeSetter) external;
    function setFeeClaimer(address newFeeClaimer) external;
    function setTickSpacingSetter(address newTickSpacingSetter) external;
    function setMarketTickSpacing(bytes32 id, uint256 newTickSpacing) external;
    function setMarketSettlementFee(bytes32 id, uint256 index, uint256 newSettlementFee) external;
    function setDefaultSettlementFee(address loanToken, uint256 index, uint256 newSettlementFee) external;
    function setMarketContinuousFee(bytes32 id, uint256 newContinuousFee) external;
    function setDefaultContinuousFee(address loanToken, uint256 newContinuousFee) external;
    function setMaxTotalUnits(address token, uint128 newMaxTotalUnits) external;
    function setMaxTakeableAssets(address token, uint256 newMaxTakeableAssets) external;
    function setMaxCollateralPerUser(address token, uint256 newMaxCollateralPerUser) external;
    function claimSettlementFee(address token, uint256 amount, address receiver) external;
    function claimContinuousFee(Market memory market, uint256 amount, address receiver) external;

    /// ENTRY-POINTS ///
    function take(Offer memory offer, bytes memory ratifierData, uint256 units, address taker, address receiverIfTakerIsSeller, address takerCallback, bytes memory takerCallbackData) external returns (uint256, uint256);
    function withdraw(Market memory market, uint256 units, address onBehalf, address receiver) external;
    function repay(Market memory market, uint256 units, address onBehalf, address callback, bytes memory data) external;
    function supplyCollateral(Market memory market, uint256 collateralIndex, uint256 assets, address onBehalf) external;
    function withdrawCollateral(Market memory market, uint256 collateralIndex, uint256 assets, address onBehalf, address receiver) external;
    function liquidate(Market memory market, uint256 collateralIndex, uint256 seizedAssets, uint256 repaidUnits, address borrower, bool postMaturityMode, address receiver, address callback, bytes memory data) external returns (uint256, uint256);
    function setConsumed(bytes32 group, uint256 amount, address onBehalf) external;
    function setIsAuthorized(address authorized, bool newIsAuthorized, address onBehalf) external;
    function flashLoan(address[] memory tokens, uint256[] memory assets, address callback, bytes memory data) external;
    function touchMarket(Market memory market) external returns (bytes32);

    /// SLASHING AND CONTINUOUS FEE ACCRUAL ///
    function updatePositionView(Market memory market, bytes32 id, address user) external view returns (uint128, uint128, uint128);
    function updatePosition(Market memory market, address user) external returns (uint128, uint128, uint128);

    /// OTHER VIEW FUNCTIONS ///
    function lastLossFactor(bytes32 id, address user) external view returns (uint128);
    function collateralBitmap(bytes32 id, address user) external view returns (uint128);
    function collateral(bytes32 id, address user, uint256 index) external view returns (uint128);
    function toId(Market memory market) external view returns (bytes32);
    function toMarket(bytes32 id) external view returns (Market memory);
    function creditOf(bytes32 id, address user) external view returns (uint128);
    function debtOf(bytes32 id, address user) external view returns (uint128);
    function totalUnits(bytes32 id) external view returns (uint128);
    function lossFactor(bytes32 id) external view returns (uint128);
    function tickSpacing(bytes32 id) external view returns (uint8);
    function withdrawable(bytes32 id) external view returns (uint128);
    function settlementFeeCbps(bytes32 id) external view returns (uint16[7] memory);
    function continuousFee(bytes32 id) external view returns (uint32);
    function continuousFeeCredit(bytes32 id) external view returns (uint128);
    function pendingFee(bytes32 id, address user) external view returns (uint128);
    function lastAccrual(bytes32 id, address user) external view returns (uint128);
    function liquidationLocked(bytes32 id, address user) external view returns (bool);
    function isHealthy(Market memory market, bytes32 id, address borrower) external view returns (bool);
    function settlementFee(bytes32 id, uint256 timeToMaturity) external view returns (uint256);
    // forgefmt: disable-end
}
