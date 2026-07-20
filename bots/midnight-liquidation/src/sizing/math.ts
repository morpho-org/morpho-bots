// Fixed-point integer primitives mirroring Midnight's UtilsLib (midnight-contracts.txt:188-214)
// exactly, including rounding direction — which is load-bearing for bit-faithful sizing. The
// implementations live in @repo/utils; re-exported here so this module stays the one documented
// surface for Midnight's math (UtilsLib.mulDivDown :208-209, .mulDivUp :213-214,
// .zeroFloorSub :201-205, .min :195-199).
export { bigintMin as min, mulDivDown, mulDivUp, zeroFloorSub } from '@repo/utils';
