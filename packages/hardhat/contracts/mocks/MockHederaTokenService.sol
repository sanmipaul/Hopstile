// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaTokenService } from "../interfaces/IHederaTokenService.sol";

/// @title MockHtsNft
/// @notice A non-fungible token as the mock token service creates it. Never deploy it to a live network.
/// @dev Exposes what a real HTS token exposes at its own address: the read side of ERC-721, `transferFrom`, and
///      the HIP-719 association functions. It also models the rule that makes HTS different from ERC-721: an
///      account can only receive the token if it is associated with it or accepts automatic associations.
contract MockHtsNft {
    int64 internal constant SUCCESS = 22;
    int64 internal constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
    int64 internal constant SENDER_DOES_NOT_OWN_NFT_SERIAL_NO = 237;

    address public immutable hts;
    address public immutable treasury;
    address public immutable supplyKey;
    uint256 public immutable maxSupply;

    string public name;
    string public symbol;
    uint256 public totalSupply;

    /// @notice Royalty the token was created with. All zero if it has none.
    IHederaTokenService.RoyaltyFee public royalty;

    mapping(address account => bool) public autoAssociationDisabled;

    mapping(uint256 serial => address owner) private _owners;
    mapping(uint256 serial => bytes metadata) private _metadata;
    mapping(address account => uint256 count) private _balances;
    mapping(address account => bool) private _associated;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    error OnlyTokenService();
    error UnknownSerial(uint256 serial);
    error NotOwner();
    error NotAssociated(address account);
    error StillHoldsTokens();

    modifier onlyHts() {
        if (msg.sender != hts) revert OnlyTokenService();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address treasury_,
        address supplyKey_,
        uint256 maxSupply_,
        IHederaTokenService.RoyaltyFee memory royalty_
    ) {
        hts = msg.sender;
        name = name_;
        symbol = symbol_;
        treasury = treasury_;
        supplyKey = supplyKey_;
        maxSupply = maxSupply_;
        royalty = royalty_;
        _associated[treasury_] = true;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Called by the token service
    // ----------------------------------------------------------------------------------------------------------

    function mint(bytes[] calldata metadata) external onlyHts returns (int64[] memory serials) {
        serials = new int64[](metadata.length);
        for (uint256 i = 0; i < metadata.length; ++i) {
            uint256 serial = ++totalSupply;
            _owners[serial] = treasury;
            _metadata[serial] = metadata[i];
            serials[i] = int64(uint64(serial));
            emit Transfer(address(0), treasury, serial);
        }
        _balances[treasury] += metadata.length;
    }

    function move(address from, address to, uint256 serial) external onlyHts returns (int64 responseCode) {
        if (_owners[serial] != from) return SENDER_DOES_NOT_OWN_NFT_SERIAL_NO;
        if (!canReceive(to)) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        _move(from, to, serial);
        return SUCCESS;
    }

    // ----------------------------------------------------------------------------------------------------------
    // ERC-721 facade
    // ----------------------------------------------------------------------------------------------------------

    function ownerOf(uint256 serial) external view returns (address owner) {
        owner = _owners[serial];
        if (owner == address(0)) revert UnknownSerial(serial);
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function tokenURI(uint256 serial) external view returns (string memory) {
        if (_owners[serial] == address(0)) revert UnknownSerial(serial);
        return string(_metadata[serial]);
    }

    function transferFrom(address from, address to, uint256 serial) external {
        if (msg.sender != from || _owners[serial] != from) revert NotOwner();
        if (!canReceive(to)) revert NotAssociated(to);
        _move(from, to, serial);
    }

    // ----------------------------------------------------------------------------------------------------------
    // HIP-719 association
    // ----------------------------------------------------------------------------------------------------------

    function associate() external returns (uint256 responseCode) {
        if (_associated[msg.sender]) return uint256(uint64(TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT));
        _associated[msg.sender] = true;
        return uint256(uint64(SUCCESS));
    }

    function dissociate() external returns (uint256 responseCode) {
        if (_balances[msg.sender] != 0) revert StillHoldsTokens();
        _associated[msg.sender] = false;
        return uint256(uint64(SUCCESS));
    }

    function isAssociated() external view returns (bool) {
        return _associated[msg.sender];
    }

    // ----------------------------------------------------------------------------------------------------------
    // Test controls
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Lets the caller refuse automatic associations, like a Hedera account with no free association
    ///         slots. Such an account must call `associate` before it can receive the token.
    function setAutoAssociation(bool enabled) external {
        autoAssociationDisabled[msg.sender] = !enabled;
    }

    /// @notice Whether a transfer to `account` would succeed.
    function canReceive(address account) public view returns (bool) {
        return account != address(0) && (_associated[account] || !autoAssociationDisabled[account]);
    }

    function _move(address from, address to, uint256 serial) private {
        _associated[to] = true;
        _owners[serial] = to;
        _balances[from] -= 1;
        _balances[to] += 1;
        emit Transfer(from, to, serial);
    }
}

/// @title MockHederaTokenService
/// @notice Stand-in for the Hedera Token Service system contract, for tests and local development. Never deploy
///         it to a live network.
/// @dev Install its runtime code at `0x167` with `hardhat_setCode`. It implements the non-fungible subset in
///      `IHederaTokenService` and, like the real system contract, reports a refusal as a response code instead of
///      reverting.
contract MockHederaTokenService {
    int64 internal constant SUCCESS = 22;
    int64 internal constant INVALID_SIGNATURE = 7;
    int64 internal constant INSUFFICIENT_TX_FEE = 9;
    int64 internal constant INVALID_TOKEN_ID = 167;
    int64 internal constant TOKEN_HAS_NO_SUPPLY_KEY = 180;
    int64 internal constant METADATA_TOO_LONG = 227;
    int64 internal constant BATCH_SIZE_LIMIT_EXCEEDED = 228;
    int64 internal constant TOKEN_MAX_SUPPLY_REACHED = 236;

    uint256 internal constant SUPPLY_KEY = 16;
    uint256 internal constant MAX_BATCH = 10;
    uint256 internal constant MAX_METADATA_BYTES = 100;

    mapping(address token => bool) public isToken;
    /// @notice The token created most recently.
    address public lastToken;

    function createNonFungibleToken(
        IHederaTokenService.HederaToken memory token
    ) external payable returns (int64 responseCode, address tokenAddress) {
        IHederaTokenService.RoyaltyFee memory none;
        return _create(token, none);
    }

    function createNonFungibleTokenWithCustomFees(
        IHederaTokenService.HederaToken memory token,
        IHederaTokenService.FixedFee[] memory /* fixedFees */,
        IHederaTokenService.RoyaltyFee[] memory royaltyFees
    ) external payable returns (int64 responseCode, address tokenAddress) {
        IHederaTokenService.RoyaltyFee memory royalty;
        if (royaltyFees.length != 0) royalty = royaltyFees[0];
        return _create(token, royalty);
    }

    function mintToken(
        address token,
        int64 /* amount */,
        bytes[] calldata metadata
    ) external returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers) {
        if (!isToken[token]) return (INVALID_TOKEN_ID, 0, serialNumbers);
        MockHtsNft nft = MockHtsNft(token);
        int64 supply = int64(uint64(nft.totalSupply()));

        if (nft.supplyKey() != msg.sender) return (INVALID_SIGNATURE, supply, serialNumbers);
        if (metadata.length == 0 || metadata.length > MAX_BATCH) {
            return (BATCH_SIZE_LIMIT_EXCEEDED, supply, serialNumbers);
        }
        for (uint256 i = 0; i < metadata.length; ++i) {
            if (metadata[i].length > MAX_METADATA_BYTES) return (METADATA_TOO_LONG, supply, serialNumbers);
        }
        if (nft.totalSupply() + metadata.length > nft.maxSupply()) {
            return (TOKEN_MAX_SUPPLY_REACHED, supply, serialNumbers);
        }

        serialNumbers = nft.mint(metadata);
        return (SUCCESS, int64(uint64(nft.totalSupply())), serialNumbers);
    }

    function transferNFT(
        address token,
        address sender,
        address recipient,
        int64 serialNumber
    ) external returns (int64 responseCode) {
        if (!isToken[token]) return INVALID_TOKEN_ID;
        if (msg.sender != sender) return INVALID_SIGNATURE;
        return MockHtsNft(token).move(sender, recipient, uint256(uint64(serialNumber)));
    }

    function _create(
        IHederaTokenService.HederaToken memory token,
        IHederaTokenService.RoyaltyFee memory royalty
    ) private returns (int64 responseCode, address tokenAddress) {
        if (msg.value == 0) return (INSUFFICIENT_TX_FEE, address(0));
        if (token.treasury != msg.sender) return (INVALID_SIGNATURE, address(0));

        address supplyKey;
        for (uint256 i = 0; i < token.tokenKeys.length; ++i) {
            if (token.tokenKeys[i].keyType & SUPPLY_KEY != 0) supplyKey = token.tokenKeys[i].key.contractId;
        }
        if (supplyKey == address(0)) return (TOKEN_HAS_NO_SUPPLY_KEY, address(0));

        tokenAddress = address(
            new MockHtsNft(
                token.name,
                token.symbol,
                token.treasury,
                supplyKey,
                uint256(uint64(token.maxSupply)),
                royalty
            )
        );
        isToken[tokenAddress] = true;
        lastToken = tokenAddress;
        return (SUCCESS, tokenAddress);
    }
}
