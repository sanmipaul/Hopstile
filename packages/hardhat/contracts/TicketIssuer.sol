// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";
import { LzOptions } from "./libraries/LzOptions.sol";
import { TicketMessages } from "./libraries/TicketMessages.sol";

/// @title TicketIssuer
/// @notice Runs on Hedera. Owns a ticket collection that is a native Hedera Token Service (HTS) NFT, and mints
///         tickets for orders that were paid for on other chains.
/// @dev How the pieces fit:
///      - The collection is an HTS non-fungible token. This contract is its treasury and holds its supply key, so
///        only this contract can mint. An optional royalty is enforced by the network on every resale.
///      - A booth is a `TicketBooth` on another chain. The owner opens a sale for a booth by sending it the terms
///        over LayerZero, and that sale reserves part of the collection's supply.
///      - The booth takes payment and sends back a mint order. `_lzReceive` mints the tickets and delivers them.
///        Because the supply was reserved when the sale opened, a paid order can always be minted.
///      - When a sale ends the booth reports how many tickets it sold, and the unsold supply is released.
contract TicketIssuer is OApp {
    /// @param name Name of the collection.
    /// @param symbol Symbol of the collection.
    /// @param memo Free text stored on the token, at most 100 bytes.
    /// @param maxSupply Largest number of tickets that can ever exist.
    /// @param metadata Stored on every ticket, at most 100 bytes. By convention a URI of a metadata JSON file.
    /// @param royaltyBps Share of every resale paid to `royaltyCollector`, in basis points. Zero for no royalty.
    /// @param royaltyFallback Tinybars charged to the receiver when a ticket moves for no payment. Zero for none.
    /// @param royaltyCollector Account that receives the royalty.
    struct Collection {
        string name;
        string symbol;
        string memo;
        uint32 maxSupply;
        bytes metadata;
        uint16 royaltyBps;
        uint64 royaltyFallback;
        address royaltyCollector;
    }

    /// @param boothEid LayerZero endpoint id of the chain the booth is on.
    /// @param price Price of one ticket, in the smallest unit of the booth chain's native currency.
    /// @param allocation Number of tickets the booth may sell.
    /// @param minted Number of tickets minted for the booth so far.
    /// @param sold Final number of tickets sold. Only meaningful once `settled` is true.
    /// @param closesAt Unix time after which the booth stops selling.
    /// @param maxPerOrder Largest number of tickets in one order.
    /// @param settled Whether the booth has reported its final count.
    struct Sale {
        uint32 boothEid;
        uint128 price;
        uint32 allocation;
        uint32 minted;
        uint32 sold;
        uint64 closesAt;
        uint8 maxPerOrder;
        bool settled;
    }

    address internal constant HTS = address(0x167);
    int64 internal constant HEDERA_SUCCESS = 22;
    /// @dev Bit of the supply key in an HTS key type.
    uint256 internal constant SUPPLY_KEY = 16;
    /// @dev HTS renews the token from this contract's balance every 90 days.
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000;
    uint256 internal constant MAX_METADATA_BYTES = 100;
    uint256 internal constant BPS = 10_000;

    /// @notice Largest order a sale can allow. HTS mints at most ten serials in one call.
    uint8 public constant MAX_PER_ORDER = 10;

    /// @notice The HTS token that represents tickets. Zero until `createCollection` runs.
    address public ticketToken;
    /// @notice Metadata stored on every ticket.
    bytes public ticketMetadata;
    /// @notice Largest number of tickets that can ever exist.
    uint32 public maxSupply;
    /// @notice Tickets minted so far.
    uint32 public totalMinted;
    /// @notice Supply promised to booths that has not been minted yet.
    uint32 public reservedSupply;
    /// @notice Number of sales opened. The latest sale has this id.
    uint64 public saleCount;
    /// @notice Gas the booth's `lzReceive` gets when it receives sale terms.
    uint128 public boothReceiveGas = 200_000;

    /// @notice Latest sale opened for a booth chain. Zero if none.
    mapping(uint32 boothEid => uint64 saleId) public activeSaleOf;
    /// @notice Whether a ticket has been used at the door.
    mapping(uint256 serial => bool) public checkedIn;

    mapping(uint64 saleId => Sale) private _sales;
    mapping(address account => uint256[] serials) private _held;

    event CollectionCreated(address indexed token, string name, string symbol, uint32 maxSupply);
    event SaleOpened(
        uint64 indexed saleId,
        uint32 indexed boothEid,
        uint128 price,
        uint32 allocation,
        uint64 closesAt,
        uint8 maxPerOrder,
        bytes32 guid
    );
    event OrderFulfilled(
        uint64 indexed saleId,
        uint64 indexed orderId,
        address indexed recipient,
        uint32 boothEid,
        uint256[] serials,
        uint256 held,
        bytes32 guid
    );
    event TicketHeld(uint256 indexed serial, address indexed recipient);
    event TicketClaimed(uint256 indexed serial, address indexed recipient);
    event SaleSettled(uint64 indexed saleId, uint32 sold, uint32 released);
    event TicketCheckedIn(uint256 indexed serial, address indexed holder);
    event BoothReceiveGasSet(uint128 gasLimit);

    error ZeroAddress();
    error CollectionExists();
    error CollectionNotCreated();
    error InvalidCollection();
    error InvalidSaleTerms();
    error SaleInProgress(uint64 saleId);
    error InsufficientSupply(uint32 available);
    error UnknownSale(uint64 saleId);
    error AllocationExceeded(uint64 saleId);
    error InvalidSettlement(uint64 saleId);
    error UnknownMessage(uint8 kind);
    error HtsCallFailed(int64 responseCode);
    error NothingToClaim();
    error TicketNotDeliverable(uint256 serial);
    error NotTicketHolder();
    error AlreadyCheckedIn(uint256 serial);
    error NativeTransferFailed();

    /// @param endpoint_ LayerZero EndpointV2 on this chain.
    /// @param owner_ Account that creates the collection and opens sales. Also the LayerZero delegate.
    constructor(address endpoint_, address owner_) OApp(endpoint_, owner_) Ownable(owner_) {}

    /// @notice Accepts HBAR, which pays the token's auto-renewal.
    receive() external payable {}

    // ----------------------------------------------------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Creates the ticket collection as an HTS non-fungible token.
    /// @dev Payable: HTS charges the creation fee from `msg.value`. This contract becomes the treasury and the
    ///      only holder of the supply key.
    function createCollection(Collection calldata collection) external payable onlyOwner returns (address token) {
        if (ticketToken != address(0)) revert CollectionExists();
        if (
            collection.maxSupply == 0 ||
            collection.metadata.length > MAX_METADATA_BYTES ||
            collection.royaltyBps >= BPS ||
            collection.royaltyFallback > uint64(type(int64).max) ||
            (collection.royaltyBps != 0 && collection.royaltyCollector == address(0))
        ) revert InvalidCollection();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });
        IHederaTokenService.HederaToken memory definition = IHederaTokenService.HederaToken({
            name: collection.name,
            symbol: collection.symbol,
            treasury: address(this),
            memo: collection.memo,
            tokenSupplyType: true,
            maxSupply: int64(uint64(collection.maxSupply)),
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0,
                autoRenewAccount: address(this),
                autoRenewPeriod: AUTO_RENEW_PERIOD
            })
        });

        int64 responseCode;
        if (collection.royaltyBps == 0) {
            (responseCode, token) = IHederaTokenService(HTS).createNonFungibleToken{ value: msg.value }(definition);
        } else {
            IHederaTokenService.RoyaltyFee[] memory royalties = new IHederaTokenService.RoyaltyFee[](1);
            royalties[0] = IHederaTokenService.RoyaltyFee({
                numerator: int64(uint64(collection.royaltyBps)),
                denominator: int64(uint64(BPS)),
                amount: int64(collection.royaltyFallback),
                tokenId: address(0),
                useHbarsForPayment: collection.royaltyFallback != 0,
                feeCollector: collection.royaltyCollector
            });
            (responseCode, token) = IHederaTokenService(HTS).createNonFungibleTokenWithCustomFees{ value: msg.value }(
                definition,
                new IHederaTokenService.FixedFee[](0),
                royalties
            );
        }
        if (responseCode != HEDERA_SUCCESS) revert HtsCallFailed(responseCode);

        ticketToken = token;
        ticketMetadata = collection.metadata;
        maxSupply = collection.maxSupply;
        emit CollectionCreated(token, collection.name, collection.symbol, collection.maxSupply);
    }

    /// @notice Opens a sale at a booth by sending it the terms over LayerZero.
    /// @dev Payable: `msg.value` pays the LayerZero fee and anything above the fee is refunded to the caller. Get
    ///      the fee from `quoteOpenSale`. On Hedera the quote is in tinybars; see the README for the unit to send.
    /// @param boothEid LayerZero endpoint id of the booth's chain. A peer must be set for it.
    /// @param price Price of one ticket, in the smallest unit of the booth chain's native currency.
    /// @param allocation Number of tickets the booth may sell. Reserved from the collection until it settles.
    /// @param closesAt Unix time after which the booth stops selling.
    /// @param maxPerOrder Largest number of tickets in one order, at most `MAX_PER_ORDER`.
    /// @return saleId Identifier of the sale.
    /// @return guid LayerZero identifier of the message, for tracking it on LayerZero Scan.
    function openSale(
        uint32 boothEid,
        uint128 price,
        uint32 allocation,
        uint64 closesAt,
        uint8 maxPerOrder
    ) external payable onlyOwner returns (uint64 saleId, bytes32 guid) {
        if (ticketToken == address(0)) revert CollectionNotCreated();
        if (allocation == 0 || closesAt <= block.timestamp || maxPerOrder == 0 || maxPerOrder > MAX_PER_ORDER) {
            revert InvalidSaleTerms();
        }
        uint64 previous = activeSaleOf[boothEid];
        if (previous != 0 && !_sales[previous].settled) revert SaleInProgress(previous);
        uint32 available = availableSupply();
        if (allocation > available) revert InsufficientSupply(available);

        saleId = ++saleCount;
        reservedSupply += allocation;
        activeSaleOf[boothEid] = saleId;
        _sales[saleId] = Sale({
            boothEid: boothEid,
            price: price,
            allocation: allocation,
            minted: 0,
            sold: 0,
            closesAt: closesAt,
            maxPerOrder: maxPerOrder,
            settled: false
        });

        MessagingReceipt memory receipt = _lzSend(
            boothEid,
            TicketMessages.encodeSaleOpened(
                TicketMessages.SaleTerms({
                    saleId: saleId,
                    price: price,
                    allocation: allocation,
                    closesAt: closesAt,
                    maxPerOrder: maxPerOrder
                })
            ),
            LzOptions.lzReceive(boothReceiveGas),
            MessagingFee(msg.value, 0),
            msg.sender
        );
        guid = receipt.guid;
        emit SaleOpened(saleId, boothEid, price, allocation, closesAt, maxPerOrder, guid);
    }

    /// @notice Sets the gas a booth's `lzReceive` gets when it receives sale terms.
    function setBoothReceiveGas(uint128 gasLimit) external onlyOwner {
        boothReceiveGas = gasLimit;
        emit BoothReceiveGasSet(gasLimit);
    }

    /// @notice Withdraws HBAR held by this contract.
    function sweepNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    // ----------------------------------------------------------------------------------------------------------
    // Ticket holders
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Collects tickets that could not be delivered when they were minted, because the caller was not
    ///         associated with the ticket token at the time.
    /// @dev Associate first by calling `associate()` on the token address.
    /// @param maxTickets Largest number of tickets to collect in this call.
    /// @return claimed Number of tickets collected.
    function claim(uint256 maxTickets) external returns (uint256 claimed) {
        uint256[] storage serials = _held[msg.sender];
        if (serials.length == 0 || maxTickets == 0) revert NothingToClaim();

        while (claimed < maxTickets && serials.length != 0) {
            uint256 serial = serials[serials.length - 1];
            serials.pop();
            if (!_deliver(msg.sender, serial)) revert TicketNotDeliverable(serial);
            emit TicketClaimed(serial, msg.sender);
            ++claimed;
        }
    }

    /// @notice Marks a ticket as used. Only its current holder can do this, and only once.
    function checkIn(uint256 serial) external {
        if (IERC721(ticketToken).ownerOf(serial) != msg.sender) revert NotTicketHolder();
        if (checkedIn[serial]) revert AlreadyCheckedIn(serial);

        checkedIn[serial] = true;
        emit TicketCheckedIn(serial, msg.sender);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    /// @notice LayerZero fee for `openSale`, in this chain's native unit as the EVM sees it (tinybars on Hedera).
    function quoteOpenSale(uint32 boothEid) external view returns (uint256 nativeFee) {
        TicketMessages.SaleTerms memory terms;
        return
            _quote(boothEid, TicketMessages.encodeSaleOpened(terms), LzOptions.lzReceive(boothReceiveGas), false)
                .nativeFee;
    }

    function getSale(uint64 saleId) external view returns (Sale memory) {
        return _sales[saleId];
    }

    /// @notice Tickets minted for `account` that are waiting to be claimed.
    function heldTicketsOf(address account) external view returns (uint256[] memory) {
        return _held[account];
    }

    /// @notice Supply that is neither minted nor reserved by a sale.
    function availableSupply() public view returns (uint32) {
        return maxSupply - totalMinted - reservedSupply;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------

    /// @dev Called by the LayerZero endpoint once a message from a peer has been verified. If it reverts, the
    ///      message stays stored in the endpoint and anyone can retry it.
    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address /* executor */,
        bytes calldata /* extraData */
    ) internal override {
        uint8 kind = TicketMessages.kind(message);
        if (kind == TicketMessages.MINT_ORDER) {
            _fulfil(origin.srcEid, guid, TicketMessages.decodeMintOrder(message));
        } else if (kind == TicketMessages.SALE_SETTLED) {
            _settle(origin.srcEid, TicketMessages.decodeSaleSettled(message));
        } else {
            revert UnknownMessage(kind);
        }
    }

    /// @dev Mints the tickets of a paid order and delivers them. A ticket that cannot be delivered is kept here
    ///      for the recipient to claim, so one unassociated account can never block an order.
    function _fulfil(uint32 srcEid, bytes32 guid, TicketMessages.MintOrder memory order) private {
        Sale storage sale = _sales[order.saleId];
        if (sale.boothEid != srcEid) revert UnknownSale(order.saleId);
        uint32 cap = sale.settled ? sale.sold : sale.allocation;
        if (order.quantity == 0 || sale.minted + order.quantity > cap) revert AllocationExceeded(order.saleId);

        sale.minted += order.quantity;
        totalMinted += order.quantity;
        reservedSupply -= order.quantity;

        uint256[] memory serials = _mint(order.quantity);
        uint256 held;
        for (uint256 i = 0; i < serials.length; ++i) {
            if (_deliver(order.recipient, serials[i])) continue;
            _held[order.recipient].push(serials[i]);
            ++held;
            emit TicketHeld(serials[i], order.recipient);
        }
        emit OrderFulfilled(order.saleId, order.orderId, order.recipient, srcEid, serials, held, guid);
    }

    /// @dev Records the booth's final count and releases the supply it did not sell. Orders that are still in
    ///      flight keep their reservation: mints for a settled sale are allowed up to `sold`.
    function _settle(uint32 srcEid, TicketMessages.Settlement memory settlement) private {
        Sale storage sale = _sales[settlement.saleId];
        if (sale.boothEid != srcEid) revert UnknownSale(settlement.saleId);
        if (sale.settled || settlement.sold > sale.allocation || settlement.sold < sale.minted) {
            revert InvalidSettlement(settlement.saleId);
        }

        uint32 released = sale.allocation - settlement.sold;
        sale.sold = settlement.sold;
        sale.settled = true;
        reservedSupply -= released;
        emit SaleSettled(settlement.saleId, settlement.sold, released);
    }

    function _mint(uint8 quantity) private returns (uint256[] memory serials) {
        bytes[] memory metadata = new bytes[](quantity);
        bytes memory ticket = ticketMetadata;
        for (uint256 i = 0; i < quantity; ++i) metadata[i] = ticket;

        (int64 responseCode, , int64[] memory minted) = IHederaTokenService(HTS).mintToken(ticketToken, 0, metadata);
        if (responseCode != HEDERA_SUCCESS || minted.length != quantity) revert HtsCallFailed(responseCode);

        serials = new uint256[](quantity);
        for (uint256 i = 0; i < quantity; ++i) serials[i] = uint256(uint64(minted[i]));
    }

    /// @dev Moves a ticket out of the treasury. Returns false instead of reverting when HTS refuses the
    ///      transfer, which it does when `to` is not associated with the token.
    function _deliver(address to, uint256 serial) private returns (bool) {
        (bool ok, bytes memory ret) = HTS.call(
            abi.encodeCall(IHederaTokenService.transferNFT, (ticketToken, address(this), to, int64(uint64(serial))))
        );
        return ok && ret.length == 32 && abi.decode(ret, (int256)) == HEDERA_SUCCESS;
    }
}
