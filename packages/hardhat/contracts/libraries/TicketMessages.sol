// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title TicketMessages
/// @notice Wire format of the three messages Hopstile sends over LayerZero.
/// @dev Every message is `abi.encode(uint8 kind, <struct>)`, so the first word identifies the message and both
///      contracts decode with the same library. Adding a message means adding a kind, a struct and a pair of
///      functions here, then handling the kind in the receiving contract's `_lzReceive`.
library TicketMessages {
    /// @dev Issuer to booth: the terms of a new sale.
    uint8 internal constant SALE_OPENED = 1;
    /// @dev Booth to issuer: a paid order to mint.
    uint8 internal constant MINT_ORDER = 2;
    /// @dev Booth to issuer: the final count of a sale that has ended.
    uint8 internal constant SALE_SETTLED = 3;

    /// @param saleId Identifier assigned by the issuer. Increases with every sale.
    /// @param price Price of one ticket in the native currency of the booth's chain, in its smallest unit.
    /// @param allocation Number of tickets the booth may sell.
    /// @param closesAt Unix time after which the booth stops selling.
    /// @param maxPerOrder Largest number of tickets in one order.
    struct SaleTerms {
        uint64 saleId;
        uint128 price;
        uint32 allocation;
        uint64 closesAt;
        uint8 maxPerOrder;
    }

    /// @param saleId Sale the order belongs to.
    /// @param orderId Identifier assigned by the booth.
    /// @param recipient Account on Hedera that receives the tickets.
    /// @param quantity Number of tickets to mint.
    struct MintOrder {
        uint64 saleId;
        uint64 orderId;
        address recipient;
        uint8 quantity;
    }

    /// @param saleId Sale that ended.
    /// @param sold Number of tickets the booth sold.
    struct Settlement {
        uint64 saleId;
        uint32 sold;
    }

    error MessageTooShort();

    /// @notice Reads the kind of a message without decoding the rest.
    function kind(bytes calldata message) internal pure returns (uint8) {
        if (message.length < 32) revert MessageTooShort();
        return uint8(uint256(bytes32(message[:32])));
    }

    function encodeSaleOpened(SaleTerms memory terms) internal pure returns (bytes memory) {
        return abi.encode(SALE_OPENED, terms);
    }

    function decodeSaleOpened(bytes calldata message) internal pure returns (SaleTerms memory terms) {
        (, terms) = abi.decode(message, (uint8, SaleTerms));
    }

    function encodeMintOrder(MintOrder memory order) internal pure returns (bytes memory) {
        return abi.encode(MINT_ORDER, order);
    }

    function decodeMintOrder(bytes calldata message) internal pure returns (MintOrder memory order) {
        (, order) = abi.decode(message, (uint8, MintOrder));
    }

    function encodeSaleSettled(Settlement memory settlement) internal pure returns (bytes memory) {
        return abi.encode(SALE_SETTLED, settlement);
    }

    function decodeSaleSettled(bytes calldata message) internal pure returns (Settlement memory settlement) {
        (, settlement) = abi.decode(message, (uint8, Settlement));
    }
}
