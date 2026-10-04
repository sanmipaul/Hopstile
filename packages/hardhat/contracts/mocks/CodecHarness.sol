// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { LzOptions } from "../libraries/LzOptions.sol";
import { TicketMessages } from "../libraries/TicketMessages.sol";

/// @title CodecHarness
/// @notice Exposes the internal functions of `LzOptions` and `TicketMessages` so tests can call them directly.
contract CodecHarness {
    function lzReceiveOptions(uint128 gasLimit) external pure returns (bytes memory) {
        return LzOptions.lzReceive(gasLimit);
    }

    function kind(bytes calldata message) external pure returns (uint8) {
        return TicketMessages.kind(message);
    }

    function encodeSaleOpened(TicketMessages.SaleTerms calldata terms) external pure returns (bytes memory) {
        return TicketMessages.encodeSaleOpened(terms);
    }

    function decodeSaleOpened(bytes calldata message) external pure returns (TicketMessages.SaleTerms memory) {
        return TicketMessages.decodeSaleOpened(message);
    }

    function encodeMintOrder(TicketMessages.MintOrder calldata order) external pure returns (bytes memory) {
        return TicketMessages.encodeMintOrder(order);
    }

    function decodeMintOrder(bytes calldata message) external pure returns (TicketMessages.MintOrder memory) {
        return TicketMessages.decodeMintOrder(message);
    }

    function encodeSaleSettled(TicketMessages.Settlement calldata settlement) external pure returns (bytes memory) {
        return TicketMessages.encodeSaleSettled(settlement);
    }

    function decodeSaleSettled(bytes calldata message) external pure returns (TicketMessages.Settlement memory) {
        return TicketMessages.decodeSaleSettled(message);
    }
}
