import { sol } from 'soltag'

// THE PRE-PROJECTION LENS, PRESERVED VERBATIM AS A TEST FIXTURE. Do not "fix", reformat, or point it
// at the vendored math — its whole value is being an independent oracle for
// `reallocation-accrual.fork.test.ts`, which diffs the production lens against it at a pinned block.
// It calls the state-changing `Morpho.accrueInterest`, so Blue itself does the accrual; that is
// precisely what production does not do.
//
// It stays readable on viem-dlc 0.0.19: it is `nonpayable`, so it can never travel through the
// paginated-lens envelope (which STATICCALLs each element), but an unmarked deployless `eth_call`
// carries no `policy` sentinel and the transport forwards it untouched. It must be read with
// low-level `call` + encode/decode, since viem's `readContract` only accepts view/pure ABI entries.
export const VaultV2AccrualReferenceLens = sol('VaultV2AccrualReferenceLens')`
// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }
struct Market {
  uint128 totalSupplyAssets;
  uint128 totalSupplyShares;
  uint128 totalBorrowAssets;
  uint128 totalBorrowShares;
  uint128 lastUpdate;
  uint128 fee;
}
struct Position { uint256 supplyShares; uint128 borrowShares; uint128 collateral; }

interface IMorpho {
  function market(bytes32 id) external view returns (Market memory);
  function position(bytes32 id, address user) external view returns (Position memory);
  function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
  function accrueInterest(MarketParams memory marketParams) external;
}

interface IVaultV2 {
  function asset() external view returns (address);
  function totalAssets() external view returns (uint256);
  function isAllocator(address account) external view returns (bool);
  function adaptersLength() external view returns (uint256);
  function adapters(uint256 index) external view returns (address);
  function absoluteCap(bytes32 id) external view returns (uint256);
  function relativeCap(bytes32 id) external view returns (uint256);
  function allocation(bytes32 id) external view returns (uint256);
}

interface IVaultV2Factory { function isVaultV2(address account) external view returns (bool); }
interface IMarketV1AdapterFactory { function isMorphoMarketV1Adapter(address account) external view returns (bool); }
interface IMarketV1AdapterV2Factory { function isMorphoMarketV1AdapterV2(address account) external view returns (bool); }

// The two Morpho Blue market adapter generations enumerate their markets differently (a params list
// vs an id list) but take identical (de)allocate calldata and derive identical cap ids.
interface IMarketV1Adapter {
  function marketParamsListLength() external view returns (uint256);
  function marketParamsList(uint256 index) external view returns (MarketParams memory);
}

interface IMarketV1AdapterV2 {
  function marketIdsLength() external view returns (uint256);
  function marketIds(uint256 index) external view returns (bytes32);
  function supplyShares(bytes32 id) external view returns (uint256);
}

interface IERC20 { function balanceOf(address account) external view returns (uint256); }
interface IAdaptiveCurveIrm { function rateAtTarget(bytes32 id) external view returns (int256); }

contract VaultV2AccrualReferenceLens {
  uint256 internal constant VIRTUAL_SHARES = 1e6;
  uint256 internal constant VIRTUAL_ASSETS = 1;

  // Factory-verified adapter generations; anything else (e.g. a MorphoVaultV1Adapter) stays 0 and
  // the fetcher fails the vault loud.
  uint8 internal constant KIND_UNKNOWN = 0;
  uint8 internal constant KIND_MARKET_V1 = 1;
  uint8 internal constant KIND_MARKET_V1_V2 = 2;

  IMorpho public immutable MORPHO;
  address public immutable ADAPTIVE_CURVE_IRM;
  IVaultV2Factory public immutable VAULT_V2_FACTORY;
  address public immutable MARKET_V1_ADAPTER_FACTORY;
  address public immutable MARKET_V1_ADAPTER_V2_FACTORY;

  // One vault, plus the EOA whose allocator bit is being probed. Role data rides the same call as
  // the market snapshot, so the tick needs no separate isAllocator read.
  struct Input { address vault; address eoa; }

  // One cap id's state, exactly the triple the vault enforces (de)allocations against.
  struct CapsOut { uint256 absoluteCap; uint256 relativeCap; uint256 allocation; }

  struct AdapterOut { address adapter; uint8 kind; }

  struct MarketOut {
    bytes32 id;
    bytes32 capId;               // keccak256(abi.encode("this/marketParams", adapter, params))
    MarketParams params;
    uint256 totalSupplyAssets;   // post-accrual
    uint256 totalSupplyShares;   // post-accrual, fee-diluted by Blue itself
    uint256 totalBorrowAssets;   // post-accrual
    uint256 elapsed;             // block.timestamp - lastUpdate BEFORE accrual
    CapsOut cap;                 // the market's own cap id
    CapsOut collateralCap;       // keccak256(abi.encode("collateralToken", collateral)); deduped client-side
    uint256 vaultAssets;         // the adapter's supply shares converted down, post-accrual
    uint256 rateAtTarget;        // 0 unless irm is the chain's canonical AdaptiveCurveIRM
  }

  struct VaultOut {
    bool isVaultV2;              // factory identity; when false every other field is left zeroed
    bool isAllocator;
    uint256 totalAssets;         // post-accrual (see the module comment on read ordering)
    uint256 idleAssets;          // asset.balanceOf(vault)
    AdapterOut[] adapters;
    CapsOut adapterCap;          // keccak256(abi.encode("this", adapter)); zeroed unless one market adapter qualifies
    MarketOut[] markets;         // enumeration order of the single qualifying adapter
  }

  constructor(
    IMorpho morpho,
    address adaptiveCurveIrm,
    IVaultV2Factory vaultV2Factory,
    address marketV1AdapterFactory,
    address marketV1AdapterV2Factory
  ) {
    MORPHO = morpho;
    ADAPTIVE_CURVE_IRM = adaptiveCurveIrm;
    VAULT_V2_FACTORY = vaultV2Factory;
    MARKET_V1_ADAPTER_FACTORY = marketV1AdapterFactory;
    MARKET_V1_ADAPTER_V2_FACTORY = marketV1AdapterV2Factory;
  }

  // SharesMathLib.toAssetsDown: the adapter's own position, rounded against the vault.
  function _toAssetsDown(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
    return (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
  }

  // No per-element try/catch, unlike the liquidation lenses: the fetcher submits one vault per call,
  // so a revert IS that vault's failure and the real reason should reach the tick's vault.error log
  // rather than being flattened into a valid=false row.
  function lens(Input[] calldata input) external returns (VaultOut[] memory output) {
    output = new VaultOut[](input.length);
    for (uint256 i = 0; i < input.length; i++) output[i] = _readVault(input[i]);
  }

  function _adapterKind(address adapter) internal view returns (uint8) {
    if (
      MARKET_V1_ADAPTER_FACTORY != address(0) &&
      IMarketV1AdapterFactory(MARKET_V1_ADAPTER_FACTORY).isMorphoMarketV1Adapter(adapter)
    ) return KIND_MARKET_V1;
    if (
      MARKET_V1_ADAPTER_V2_FACTORY != address(0) &&
      IMarketV1AdapterV2Factory(MARKET_V1_ADAPTER_V2_FACTORY).isMorphoMarketV1AdapterV2(adapter)
    ) return KIND_MARKET_V1_V2;
    return KIND_UNKNOWN;
  }

  function _caps(IVaultV2 vault, bytes32 id) internal view returns (CapsOut memory) {
    return CapsOut({
      absoluteCap: vault.absoluteCap(id),
      relativeCap: vault.relativeCap(id),
      allocation: vault.allocation(id)
    });
  }

  function _readVault(Input calldata e) internal returns (VaultOut memory o) {
    o.isVaultV2 = VAULT_V2_FACTORY.isVaultV2(e.vault);
    // Nothing else about a non-factory address is safe to call; the fetcher rejects on this bit.
    if (!o.isVaultV2) return o;

    IVaultV2 vault = IVaultV2(e.vault);
    o.isAllocator = vault.isAllocator(e.eoa);
    o.idleAssets = IERC20(vault.asset()).balanceOf(e.vault);

    uint256 count = vault.adaptersLength();
    o.adapters = new AdapterOut[](count);
    uint256 qualifying = 0;
    uint256 marketAdapterIndex = 0;
    for (uint256 i = 0; i < count; i++) {
      address adapter = vault.adapters(i);
      uint8 kind = _adapterKind(adapter);
      o.adapters[i] = AdapterOut({ adapter: adapter, kind: kind });
      if (kind != KIND_UNKNOWN) {
        qualifying++;
        marketAdapterIndex = i;
      }
    }

    // Markets are read only for the shape the bot supports (one adapter, and it is a Morpho Blue
    // market adapter); any other shape returns bare adapter rows for the fetcher's error message.
    if (count == 1 && qualifying == 1) {
      AdapterOut memory qualified = o.adapters[marketAdapterIndex];
      o.markets = qualified.kind == KIND_MARKET_V1
        ? _readV1Markets(vault, qualified.adapter)
        : _readV2Markets(vault, qualified.adapter);
      o.adapterCap = _caps(vault, keccak256(abi.encode("this", qualified.adapter)));
    }

    // AFTER the per-market accruals — accrueInterestView folds the adapters' realAssets.
    o.totalAssets = vault.totalAssets();
  }

  function _readV1Markets(IVaultV2 vault, address adapter) internal returns (MarketOut[] memory markets) {
    uint256 length = IMarketV1Adapter(adapter).marketParamsListLength();
    markets = new MarketOut[](length);
    for (uint256 i = 0; i < length; i++) {
      MarketParams memory params = IMarketV1Adapter(adapter).marketParamsList(i);
      // MarketParamsLib.id: the Blue market id is the hash of its params.
      bytes32 id = keccak256(abi.encode(params));
      markets[i] = _readMarket(vault, adapter, id, params, MORPHO.position(id, adapter).supplyShares);
    }
  }

  function _readV2Markets(IVaultV2 vault, address adapter) internal returns (MarketOut[] memory markets) {
    uint256 length = IMarketV1AdapterV2(adapter).marketIdsLength();
    markets = new MarketOut[](length);
    for (uint256 i = 0; i < length; i++) {
      bytes32 id = IMarketV1AdapterV2(adapter).marketIds(i);
      markets[i] = _readMarket(
        vault,
        adapter,
        id,
        MORPHO.idToMarketParams(id),
        IMarketV1AdapterV2(adapter).supplyShares(id)
      );
    }
  }

  function _readMarket(
    IVaultV2 vault,
    address adapter,
    bytes32 id,
    MarketParams memory params,
    uint256 shares
  ) internal returns (MarketOut memory o) {
    // Accrue FIRST. Every read after this line — the market totals, the adapter's assets, and the
    // IRM's STORED rateAtTarget, which only advances when Blue calls borrowRate — is then the
    // exact on-chain state at this block, with no client-side accrual to keep in sync.
    o.elapsed = block.timestamp - MORPHO.market(id).lastUpdate;
    MORPHO.accrueInterest(params);
    Market memory m = MORPHO.market(id);

    o.id = id;
    o.params = params;
    o.totalSupplyAssets = m.totalSupplyAssets;
    o.totalSupplyShares = m.totalSupplyShares;
    o.totalBorrowAssets = m.totalBorrowAssets;
    o.vaultAssets = _toAssetsDown(shares, m.totalSupplyAssets, m.totalSupplyShares);

    if (params.irm == ADAPTIVE_CURVE_IRM) {
      int256 signedRate = IAdaptiveCurveIrm(params.irm).rateAtTarget(id);
      if (signedRate > 0) o.rateAtTarget = uint256(signedRate);
    }

    o.capId = keccak256(abi.encode("this/marketParams", adapter, params));
    o.cap = _caps(vault, o.capId);
    o.collateralCap = _caps(vault, keccak256(abi.encode("collateralToken", params.collateralToken)));
  }
}
`
