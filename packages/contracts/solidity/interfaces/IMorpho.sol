// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2025 Morpho Association
//
// VENDORED from morpho-org/morpho-blue (src/interfaces/IMorpho.sol + EventsLib.sol), trimmed to the
// surface the blue-liquidation bot needs: the three market structs, the borrower-discovery event set,
// and the read/entry functions the lens and executor path reference. The deployed Base singleton
// (0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb) emits exactly these events and exposes these signatures
// (verified on-chain). We use `bytes32` in place of Blue's `type Id is bytes32` user-defined value
// type — the ABI encoding is identical (Id is a bytes32) and it keeps rindexer/viem decoding plain,
// matching the sibling IMidnight vendoring.
//
// Structs are file-level so the generated ABI carries internalType "struct Market" (not
// "struct IMorpho.Market"). All fields are static, so the auto-generated public-mapping getters
// (`market`, `position`) — which return flat tuples on-chain — ABI-decode byte-identically to these
// memory-struct returns. Regenerate the ABI with `bun run --filter @repo/contracts build`.
pragma solidity >=0.5.0;

/// @dev Immutable market definition. `id = keccak256(abi.encode(marketParams))`; field ORDER is
/// load-bearing (any reorder changes the id). Not stored on the singleton — recovered from the
/// `CreateMarket` event and re-derived by the lens as an id-commitment check.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @dev Mutable per-market accounting returned by `market(id)`. Interest accrual adds to
/// totalSupplyAssets/totalBorrowAssets only; totalBorrowShares is never changed by accrual.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @dev Per-(market, user) position returned by `position(id, user)`.
struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

interface IMorpho {
    /// EVENTS ///
    // Mirrors morpho-blue EventsLib so the generated MorphoAbi exposes them for log decoding and for
    // the co-located rindexer (which indexes CreateMarket + Borrow for borrower discovery). Indexed
    // annotations are load-bearing for rindexer topic filters — NOTE the asymmetry: Borrow and
    // WithdrawCollateral do NOT index `caller`, whereas Repay/SupplyCollateral/Liquidate DO.
    event CreateMarket(bytes32 indexed id, MarketParams marketParams);
    event Borrow(
        bytes32 indexed id,
        address caller,
        address indexed onBehalf,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
    event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares);
    event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets);
    event WithdrawCollateral(
        bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets
    );
    event Liquidate(
        bytes32 indexed id,
        address indexed caller,
        address indexed borrower,
        uint256 repaidAssets,
        uint256 repaidShares,
        uint256 seizedAssets,
        uint256 badDebtAssets,
        uint256 badDebtShares
    );

    /// STORAGE GETTERS ///
    function market(bytes32 id) external view returns (Market memory m);
    function position(bytes32 id, address user) external view returns (Position memory p);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function isIrmEnabled(address irm) external view returns (bool);
    function isLltvEnabled(uint256 lltv) external view returns (bool);

    /// ENTRY-POINTS ///
    function accrueInterest(MarketParams memory marketParams) external;
    /// @dev Pass exactly one of `seizedAssets` / `repaidShares` nonzero (the other zero). Returns
    /// (seizedAssets, repaidAssets) — collateral seized, then loan repaid.
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256, uint256);
}
