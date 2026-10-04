// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title LzOptions
/// @notice Builds the LayerZero execution options Hopstile attaches to a message.
/// @dev Options tell the LayerZero executor how much gas to give `lzReceive` on the destination chain. The sender
///      pays for that gas up front, in the source chain's native currency, as part of the messaging fee.
///
///      The layout is LayerZero's "type 3" options with one executor option:
///
///      | bytes | field       | value                                  |
///      | ----- | ----------- | -------------------------------------- |
///      | 2     | options type| `3`                                    |
///      | 1     | worker id   | `1`, the executor                      |
///      | 2     | option size | `17`: one type byte plus sixteen of gas |
///      | 1     | option type | `1`, `lzReceive`                       |
///      | 16    | gas         | gas limit for `lzReceive`              |
///
///      It is byte-for-byte what `OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas, 0)` produces.
library LzOptions {
    uint16 internal constant TYPE_3 = 3;
    uint8 internal constant EXECUTOR_WORKER_ID = 1;
    uint8 internal constant OPTION_TYPE_LZ_RECEIVE = 1;
    uint16 internal constant LZ_RECEIVE_OPTION_SIZE = 17;

    /// @param gasLimit Gas the executor gives `lzReceive` on the destination chain.
    function lzReceive(uint128 gasLimit) internal pure returns (bytes memory) {
        return abi.encodePacked(TYPE_3, EXECUTOR_WORKER_ID, LZ_RECEIVE_OPTION_SIZE, OPTION_TYPE_LZ_RECEIVE, gasLimit);
    }
}
