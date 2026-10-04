// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { MessagingFee, MessagingParams, MessagingReceipt, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { ILayerZeroReceiver } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";

/// @title MockEndpointV2
/// @notice Stand-in for a LayerZero EndpointV2, for tests and local development. Never deploy it to a live network.
/// @dev Deploy one per simulated chain and link them with `setRemote`. A message sent through one endpoint is
///      handed to the other, which calls `lzReceive` on the receiver with the gas the sender paid for.
///
///      What it keeps from the real endpoint:
///      - `quote`, `send` and `setDelegate` have the real signatures, so an OApp needs no changes.
///      - The fee grows with the `lzReceive` gas requested in the options, and the surplus is refunded.
///      - A message whose `lzReceive` reverts does not revert the sender. It stays stored and can be retried.
///
///      What it leaves out: verification by DVNs, message libraries, ordered delivery and fees in the LZ token.
contract MockEndpointV2 {
    struct Packet {
        uint32 srcEid;
        address sender;
        address receiver;
        uint64 nonce;
        bytes32 guid;
        uint128 gasLimit;
        bool delivered;
        bytes message;
    }

    /// @notice LayerZero endpoint id of the chain this endpoint stands for.
    uint32 public immutable eid;

    /// @notice Flat part of the fee charged for every message.
    uint256 public baseFee = 1_000_000;
    /// @notice Fee charged per unit of `lzReceive` gas requested.
    uint256 public feePerGas = 10;
    /// @notice Whether a message is delivered in the transaction that sends it. Turn off to deliver by hand.
    bool public autoDeliver = true;

    mapping(uint32 remoteEid => MockEndpointV2 endpoint) public remotes;
    mapping(address oapp => address delegate) public delegates;
    mapping(address sender => mapping(uint32 dstEid => uint64 nonce)) public outboundNonce;

    Packet[] private _inbox;

    event DelegateSet(address sender, address delegate);
    event PacketSent(bytes32 indexed guid, uint32 dstEid, address sender, address receiver, uint64 nonce);
    event PacketDelivered(uint256 indexed index, bytes32 indexed guid);
    event PacketFailed(uint256 indexed index, bytes32 indexed guid, bytes reason);

    error UnknownEid(uint32 eid);
    error NotRemoteEndpoint();
    error InvalidOptions();
    error InsufficientFee(uint256 required, uint256 supplied);
    error AlreadyDelivered(uint256 index);
    error RefundFailed();

    constructor(uint32 eid_) {
        eid = eid_;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Functions an OApp calls
    // ----------------------------------------------------------------------------------------------------------

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
        emit DelegateSet(msg.sender, delegate);
    }

    function quote(MessagingParams calldata params, address /* sender */) external view returns (MessagingFee memory) {
        if (address(remotes[params.dstEid]) == address(0)) revert UnknownEid(params.dstEid);
        return MessagingFee(_fee(_lzReceiveGas(params.options)), 0);
    }

    function send(
        MessagingParams calldata params,
        address refundAddress
    ) external payable returns (MessagingReceipt memory receipt) {
        MockEndpointV2 remote = remotes[params.dstEid];
        if (address(remote) == address(0)) revert UnknownEid(params.dstEid);

        uint128 gasLimit = _lzReceiveGas(params.options);
        uint256 fee = _fee(gasLimit);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);

        uint64 nonce = ++outboundNonce[msg.sender][params.dstEid];
        address receiver = address(uint160(uint256(params.receiver)));
        bytes32 guid = keccak256(
            abi.encodePacked(nonce, eid, bytes32(uint256(uint160(msg.sender))), params.dstEid, params.receiver)
        );
        emit PacketSent(guid, params.dstEid, msg.sender, receiver, nonce);

        remote.receivePacket(
            Packet({
                srcEid: eid,
                sender: msg.sender,
                receiver: receiver,
                nonce: nonce,
                guid: guid,
                gasLimit: gasLimit,
                delivered: false,
                message: params.message
            })
        );

        if (msg.value > fee) {
            (bool ok, ) = refundAddress.call{ value: msg.value - fee }("");
            if (!ok) revert RefundFailed();
        }
        return MessagingReceipt(guid, nonce, MessagingFee(fee, 0));
    }

    // ----------------------------------------------------------------------------------------------------------
    // Delivery
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Called by the endpoint of the source chain to hand over a message.
    function receivePacket(Packet calldata packet) external {
        if (msg.sender != address(remotes[packet.srcEid])) revert NotRemoteEndpoint();

        _inbox.push(packet);
        if (autoDeliver) _deliver(_inbox.length - 1, packet.gasLimit);
    }

    /// @notice Delivers a stored message with the gas its sender paid for, as the executor does.
    function deliver(uint256 index) external {
        _deliver(index, _inbox[index].gasLimit);
    }

    /// @notice Delivers a stored message with all the gas of this call, as a manual retry does.
    function retry(uint256 index) external {
        _deliver(index, gasleft());
    }

    // ----------------------------------------------------------------------------------------------------------
    // Test controls
    // ----------------------------------------------------------------------------------------------------------

    function setRemote(uint32 remoteEid, MockEndpointV2 endpoint) external {
        remotes[remoteEid] = endpoint;
    }

    function setFees(uint256 baseFee_, uint256 feePerGas_) external {
        baseFee = baseFee_;
        feePerGas = feePerGas_;
    }

    function setAutoDeliver(bool enabled) external {
        autoDeliver = enabled;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function inboxLength() external view returns (uint256) {
        return _inbox.length;
    }

    function getPacket(uint256 index) external view returns (Packet memory) {
        return _inbox[index];
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------

    function _deliver(uint256 index, uint256 gasLimit) private {
        Packet storage packet = _inbox[index];
        if (packet.delivered) revert AlreadyDelivered(index);

        packet.delivered = true;
        Origin memory origin = Origin(packet.srcEid, bytes32(uint256(uint160(packet.sender))), packet.nonce);
        try
            ILayerZeroReceiver(packet.receiver).lzReceive{ gas: gasLimit }(
                origin,
                packet.guid,
                packet.message,
                address(this),
                ""
            )
        {
            emit PacketDelivered(index, packet.guid);
        } catch (bytes memory reason) {
            packet.delivered = false;
            emit PacketFailed(index, packet.guid, reason);
        }
    }

    function _fee(uint128 gasLimit) private view returns (uint256) {
        return baseFee + feePerGas * gasLimit;
    }

    /// @dev Reads the gas of the executor `lzReceive` option from type-3 options, as built by `LzOptions`.
    function _lzReceiveGas(bytes calldata options) private pure returns (uint128) {
        if (
            options.length < 22 || uint16(bytes2(options[0:2])) != 3 || uint8(options[2]) != 1 || uint8(options[5]) != 1
        ) revert InvalidOptions();
        return uint128(bytes16(options[6:22]));
    }
}
