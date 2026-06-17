// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IExecutor, Placeholder} from "./interfaces/IExecutor.sol";

// Vendored from Rubilmax/executooor `contracts/Executor.sol` with ONE functional modification
// (TIB-2026-05-28-midnight-liquidation-bot §Executooor integration): the `OWNER` immutable,
// constructor argument, and `require(msg.sender == OWNER)` in `exec_606BaXt` are removed, making
// the contract a permissionless SHARED singleton. (The only other diff is textual: the exact
// `pragma solidity 0.8.25` is relaxed to `^0.8.25` so the repo's pinned solc can compile-verify
// the vendored copy in tests.) Everything else — including all
// Midnight-specific behavior — lives in the caller's encoding: Midnight's `onLiquidate` callback
// is serviced by the context-gated `fallback` below, which runs the queued calls embedded in the
// callback's `data` and returns the trailing `bytes` raw (the caller encodes
// `abi.encode(CALLBACK_SUCCESS)` there).
//
// Security model: the burden is entirely on each caller, per transaction. Any caller can execute
// any call batch, so the contract makes NO custody guarantee — any token or ETH balance it holds
// between transactions is claimable by the next caller. Every plan must end by sweeping all
// assets it touched, and the bot's simulate step rejects plans that would leave a residual.
// Likewise, allowance hygiene is unenforceable by construction (anyone can pre-set any allowance
// from this contract), so encoders must not rely on a zero starting allowance — e.g. emit
// approve(0)+approve(amount) pairs for approve-from-nonzero-reverting tokens.
//
// Requires a Cancun-capable chain and compiler target: `tload`/`tstore` (EIP-1153) and `mcopy`
// (EIP-5656) are emitted via assembly, so an older EVM target fails at runtime, not compile time.

uint256 constant FALLBACK_CONTEXT_TLOC = 0;

contract Executor is IExecutor {
    /* EXTERNAL */

    /// @notice Executes a batch of calls.
    /// @dev Permissionless (the vendoring modification): any caller may execute any batch.
    function exec_606BaXt(bytes[] memory data) external payable {
        _multicall(data);
    }

    /// @notice Executes a normal call, requiring its success.
    /// @param target The target address to call.
    /// @param value The value of the call.
    /// @param context The 32-bytes concatenation of:
    /// - the address expected to call back. Set to address(0) to prevent any callback.
    /// - the expected callback data index.
    /// @param callData the calldata of the call.
    function call_g0oyU7o(address target, uint256 value, bytes32 context, bytes memory callData) public payable {
        require(msg.sender == address(this));

        bytes32 prevContext = _tload(FALLBACK_CONTEXT_TLOC);

        _tstore(FALLBACK_CONTEXT_TLOC, context);

        (bool success, bytes memory returnData) = target.call{value: value}(callData);
        if (!success) _revert(returnData);

        _tstore(FALLBACK_CONTEXT_TLOC, prevContext);
    }

    /// @notice Executes a normal call, requiring its success.
    /// @param target The target address to call.
    /// @param value The value of the call.
    /// @param context The 32-bytes concatenation of:
    /// - the address expected to call back. Set to address(0) to prevent any callback.
    /// - the expected callback data index.
    /// @param callData the calldata of the call.
    function callWithPlaceholders4845164670(
        address target,
        uint256 value,
        bytes32 context,
        bytes memory callData,
        Placeholder[] calldata placeholders
    ) external payable {
        for (uint256 i; i < placeholders.length; ++i) {
            Placeholder calldata placeholder = placeholders[i];

            (bool success, bytes memory resData) = placeholder.to.staticcall(placeholder.data);
            if (!success) _revert(resData);

            uint64 offset = placeholder.offset;
            uint64 length = placeholder.length;
            uint64 resOffset = placeholder.resOffset;

            assembly ("memory-safe") {
                mcopy(add(callData, add(32, offset)), add(resData, add(32, resOffset)), length)
            }
        }

        call_g0oyU7o(target, value, context, callData);
    }

    /// @notice Transfers ETH to the recipient.
    /// @param recipient The recipient of the transfer. Set to address(0) to transfer to the coinbase.
    /// @param amount The amount to transfer. Automatically minimumed to the current ETH balance.
    function transfer(address recipient, uint256 amount) external payable {
        require(msg.sender == address(this));

        if (recipient == address(0)) recipient = block.coinbase;

        amount = _min(amount, address(this).balance);

        (bool success, bytes memory returnData) = recipient.call{value: amount}("");
        if (!success) _revert(returnData);
    }

    receive() external payable {}

    fallback(bytes calldata) external payable returns (bytes memory returnData) {
        bytes32 context = _tload(FALLBACK_CONTEXT_TLOC);
        require(msg.sender == address(uint160(uint256(context))));

        uint256 dataIndex = uint256(context >> 160);

        bytes memory fallbackData;
        assembly ("memory-safe") {
            let offset := add(4, calldataload(add(4, mul(32, dataIndex))))
            let length := calldataload(offset)

            fallbackData := mload(0x40)

            calldatacopy(fallbackData, offset, add(32, length))

            mstore(0x40, add(fallbackData, add(32, length)))
        }

        bytes[] memory multicallData;
        (multicallData, returnData) = abi.decode(fallbackData, (bytes[], bytes));

        _multicall(multicallData);
    }

    /* INTERNAL */

    /// @notice Executes a series of calls.
    function _multicall(bytes[] memory data) internal {
        for (uint256 i; i < data.length; ++i) {
            (bool success, bytes memory returnData) = address(this).call(data[i]);
            if (!success) _revert(returnData);
        }
    }

    /// @dev Bubbles up the revert reason / custom error encoded in `returnData`.
    /// @dev Assumes `returnData` is the return data of any kind of failing CALL to a contract.
    function _revert(bytes memory returnData) internal pure {
        uint256 length = returnData.length;
        require(length > 0);

        assembly ("memory-safe") {
            revert(add(32, returnData), length)
        }
    }

    function _tload(uint256 tloc) internal view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := tload(tloc)
        }
    }

    function _tstore(uint256 tloc, bytes32 value) internal {
        assembly ("memory-safe") {
            tstore(tloc, value)
        }
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        assembly {
            z := xor(x, mul(xor(x, y), lt(y, x)))
        }
    }
}
