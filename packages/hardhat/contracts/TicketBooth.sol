// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { LzOptions } from "./libraries/LzOptions.sol";
import { TicketMessages } from "./libraries/TicketMessages.sol";

/// @title TicketBooth
/// @notice Runs on a chain other than Hedera. Sells tickets for the chain's native currency and sends each paid
///         order to the `TicketIssuer` on Hedera, which mints the tickets there.
/// @dev How the pieces fit:
///      - The booth holds no ticket inventory. It learns the price, the allocation and the closing time of a sale
///        from a LayerZero message sent by the issuer, and it can never sell more than that allocation.
///      - A buyer pays the ticket price and the LayerZero fee in one transaction. The fee buys the gas the issuer
///        needs on Hedera to mint and deliver the tickets.
///      - When the sale is over, anyone can settle it. Settling reports the final count to the issuer, which
///        releases the unsold supply.
contract TicketBooth is OApp, ReentrancyGuard {
    /// @param saleId Identifier assigned by the issuer. Zero until the first sale arrives.
    /// @param price Price of one ticket, in wei.
    /// @param allocation Number of tickets this booth may sell.
    /// @param sold Number of tickets sold so far.
    /// @param closesAt Unix time after which the booth stops selling.
    /// @param maxPerOrder Largest number of tickets in one order.
    /// @param settled Whether the final count has been sent to the issuer.
    struct Sale {
        uint64 saleId;
        uint128 price;
        uint32 allocation;
        uint32 sold;
        uint64 closesAt;
        uint8 maxPerOrder;
        bool settled;
    }

    /// @notice Gas the issuer's `lzReceive` gets on Hedera. HTS charges its fees as gas, so minting costs far more
    ///         gas than a storage write does.
    /// @param mintBase Gas for a mint order, before the per-ticket part.
    /// @param mintPerTicket Extra gas for each ticket in a mint order.
    /// @param settle Gas for a settlement message.
    struct GasConfig {
        uint128 mintBase;
        uint128 mintPerTicket;
        uint128 settle;
    }

    /// @notice LayerZero endpoint id of the chain the issuer is on.
    uint32 public immutable issuerEid;

    GasConfig public gasConfig;
    /// @notice Number of orders taken. The latest order has this id.
    uint64 public orderCount;
    /// @notice Ticket revenue waiting to be withdrawn, in wei.
    uint256 public proceeds;

    Sale private _sale;

    event SaleListed(uint64 indexed saleId, uint128 price, uint32 allocation, uint64 closesAt, uint8 maxPerOrder);
    event TicketsOrdered(
        uint64 indexed orderId,
        uint64 indexed saleId,
        address indexed buyer,
        address recipient,
        uint8 quantity,
        uint256 cost,
        bytes32 guid
    );
    event SaleSettlementSent(uint64 indexed saleId, uint32 sold, bytes32 guid);
    event ProceedsWithdrawn(address indexed to, uint256 amount);
    event GasConfigSet(uint128 mintBase, uint128 mintPerTicket, uint128 settle);

    error ZeroAddress();
    error InvalidGasConfig();
    error NotIssuerChain(uint32 eid);
    error UnknownMessage(uint8 kind);
    error PreviousSaleNotSettled(uint64 saleId);
    error StaleSale(uint64 saleId);
    error SaleNotOpen();
    error SaleStillOpen();
    error InvalidQuantity();
    error SoldOut(uint32 remaining);
    error InsufficientPayment(uint256 cost);
    error NothingToWithdraw();
    error NativeTransferFailed();

    /// @param endpoint_ LayerZero EndpointV2 on this chain.
    /// @param owner_ Account that withdraws proceeds and tunes gas. Also the LayerZero delegate.
    /// @param issuerEid_ LayerZero endpoint id of the issuer's chain.
    /// @param gasConfig_ Gas budgets for the messages this booth sends.
    constructor(
        address endpoint_,
        address owner_,
        uint32 issuerEid_,
        GasConfig memory gasConfig_
    ) OApp(endpoint_, owner_) Ownable(owner_) {
        issuerEid = issuerEid_;
        _setGasConfig(gasConfig_);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Buying
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Buys tickets. They are minted on Hedera and delivered to `recipient` once the message arrives.
    /// @dev Send at least the total from `quoteBuy`. Anything above the ticket cost is offered to LayerZero as
    ///      the fee, and LayerZero refunds what it does not need to the caller.
    /// @param recipient Account on Hedera that receives the tickets.
    /// @param quantity Number of tickets, from 1 to the sale's `maxPerOrder`.
    /// @return orderId Identifier of the order.
    /// @return guid LayerZero identifier of the message, for tracking it on LayerZero Scan.
    function buy(
        address recipient,
        uint8 quantity
    ) external payable nonReentrant returns (uint64 orderId, bytes32 guid) {
        if (recipient == address(0)) revert ZeroAddress();
        Sale memory current = _sale;
        if (!_isOpen(current)) revert SaleNotOpen();
        if (quantity == 0 || quantity > current.maxPerOrder) revert InvalidQuantity();
        uint32 remaining = current.allocation - current.sold;
        if (quantity > remaining) revert SoldOut(remaining);
        uint256 cost = uint256(current.price) * quantity;
        if (msg.value < cost) revert InsufficientPayment(cost);

        _sale.sold = current.sold + quantity;
        proceeds += cost;
        orderId = ++orderCount;

        MessagingReceipt memory receipt = _lzSend(
            issuerEid,
            TicketMessages.encodeMintOrder(
                TicketMessages.MintOrder({
                    saleId: current.saleId,
                    orderId: orderId,
                    recipient: recipient,
                    quantity: quantity
                })
            ),
            _mintOptions(quantity),
            MessagingFee(msg.value - cost, 0),
            msg.sender
        );
        guid = receipt.guid;
        emit TicketsOrdered(orderId, current.saleId, msg.sender, recipient, quantity, cost, guid);
    }

    /// @notice Ends a sale by sending its final count to the issuer. Anyone can call this once the sale has
    ///         closed or sold out.
    /// @dev Payable: `msg.value` pays the LayerZero fee from `quoteSettle`; the surplus is refunded to the caller.
    /// @return guid LayerZero identifier of the message.
    function settleSale() external payable nonReentrant returns (bytes32 guid) {
        Sale memory current = _sale;
        if (current.saleId == 0 || current.settled) revert SaleNotOpen();
        if (block.timestamp < current.closesAt && current.sold < current.allocation) revert SaleStillOpen();

        _sale.settled = true;

        MessagingReceipt memory receipt = _lzSend(
            issuerEid,
            TicketMessages.encodeSaleSettled(TicketMessages.Settlement({ saleId: current.saleId, sold: current.sold })),
            LzOptions.lzReceive(gasConfig.settle),
            MessagingFee(msg.value, 0),
            msg.sender
        );
        guid = receipt.guid;
        emit SaleSettlementSent(current.saleId, current.sold, guid);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Sends all ticket revenue to `to`.
    function withdrawProceeds(address payable to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = proceeds;
        if (amount == 0) revert NothingToWithdraw();

        proceeds = 0;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
        emit ProceedsWithdrawn(to, amount);
    }

    /// @notice Changes the gas budgets of the messages this booth sends.
    function setGasConfig(GasConfig calldata gasConfig_) external onlyOwner {
        _setGasConfig(gasConfig_);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function currentSale() external view returns (Sale memory) {
        return _sale;
    }

    /// @notice Whether tickets can be bought right now.
    function isOpen() external view returns (bool) {
        return _isOpen(_sale);
    }

    /// @notice What `buy` costs for `quantity` tickets.
    /// @return cost Ticket price times quantity, in wei.
    /// @return lzFee LayerZero fee, in wei.
    /// @return total Amount to send with `buy`.
    function quoteBuy(uint8 quantity) external view returns (uint256 cost, uint256 lzFee, uint256 total) {
        TicketMessages.MintOrder memory order;
        cost = uint256(_sale.price) * quantity;
        lzFee = _quote(issuerEid, TicketMessages.encodeMintOrder(order), _mintOptions(quantity), false).nativeFee;
        total = cost + lzFee;
    }

    /// @notice LayerZero fee for `settleSale`, in wei.
    function quoteSettle() external view returns (uint256 nativeFee) {
        TicketMessages.Settlement memory settlement;
        return
            _quote(
                issuerEid,
                TicketMessages.encodeSaleSettled(settlement),
                LzOptions.lzReceive(gasConfig.settle),
                false
            ).nativeFee;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------

    /// @dev Called by the LayerZero endpoint once a message from the issuer has been verified. The issuer only
    ///      opens a sale after the previous one settled, so the checks below fail only if the two contracts have
    ///      been wired or changed inconsistently.
    function _lzReceive(
        Origin calldata origin,
        bytes32 /* guid */,
        bytes calldata message,
        address /* executor */,
        bytes calldata /* extraData */
    ) internal override {
        if (origin.srcEid != issuerEid) revert NotIssuerChain(origin.srcEid);
        uint8 kind = TicketMessages.kind(message);
        if (kind != TicketMessages.SALE_OPENED) revert UnknownMessage(kind);

        TicketMessages.SaleTerms memory terms = TicketMessages.decodeSaleOpened(message);
        Sale memory current = _sale;
        if (current.saleId != 0 && !current.settled) revert PreviousSaleNotSettled(current.saleId);
        if (terms.saleId <= current.saleId) revert StaleSale(terms.saleId);

        _sale = Sale({
            saleId: terms.saleId,
            price: terms.price,
            allocation: terms.allocation,
            sold: 0,
            closesAt: terms.closesAt,
            maxPerOrder: terms.maxPerOrder,
            settled: false
        });
        emit SaleListed(terms.saleId, terms.price, terms.allocation, terms.closesAt, terms.maxPerOrder);
    }

    /// @dev The OApp default requires `msg.value` to equal the fee exactly. `buy` receives the ticket price and
    ///      the fee in one payment, so it passes only the part above the price as the fee. The endpoint checks
    ///      that this is enough and refunds the rest, and no call can spend more than its own `msg.value`.
    function _payNative(uint256 nativeFee) internal pure override returns (uint256) {
        return nativeFee;
    }

    function _setGasConfig(GasConfig memory gasConfig_) private {
        if (gasConfig_.mintBase == 0 || gasConfig_.mintPerTicket == 0 || gasConfig_.settle == 0) {
            revert InvalidGasConfig();
        }
        gasConfig = gasConfig_;
        emit GasConfigSet(gasConfig_.mintBase, gasConfig_.mintPerTicket, gasConfig_.settle);
    }

    function _mintOptions(uint8 quantity) private view returns (bytes memory) {
        GasConfig memory gas = gasConfig;
        return LzOptions.lzReceive(gas.mintBase + gas.mintPerTicket * quantity);
    }

    function _isOpen(Sale memory current) private view returns (bool) {
        return
            current.saleId != 0 &&
            !current.settled &&
            block.timestamp < current.closesAt &&
            current.sold < current.allocation;
    }
}
