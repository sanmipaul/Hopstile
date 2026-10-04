// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// @title IHederaTokenService
/// @notice The part of the Hedera Token Service system contract (`0x167`) that Hopstile uses: creating a
///         non-fungible token, minting serials and moving them.
/// @dev Struct layouts match the official interface. The system contract decodes them by position, so a field
///      must not be added, removed or reordered.
interface IHederaTokenService {
    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    /// @param keyType Bit field of the roles the key holds. `16` is the supply key, which mints and burns.
    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    /// @param tokenSupplyType `true` for a finite supply capped at `maxSupply`.
    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType;
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    struct FixedFee {
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        bool useCurrentTokenForPayment;
        address feeCollector;
    }

    /// @notice A share of the value exchanged for an NFT, charged by the network on every transfer that is not
    ///         from the treasury.
    /// @param numerator Royalty fraction numerator.
    /// @param denominator Royalty fraction denominator.
    /// @param amount Fallback fee charged when the NFT moves for no fungible value. Zero for no fallback.
    /// @param tokenId Token the fallback fee is paid in. Zero address when it is paid in HBAR.
    /// @param useHbarsForPayment Whether the fallback fee is paid in HBAR (`amount` is then in tinybars).
    /// @param feeCollector Account that receives the royalty.
    struct RoyaltyFee {
        int64 numerator;
        int64 denominator;
        int64 amount;
        address tokenId;
        bool useHbarsForPayment;
        address feeCollector;
    }

    /// @notice Creates a non-fungible token. The creation fee is paid with `msg.value`.
    /// @return responseCode `22` on success.
    /// @return tokenAddress Address of the new token.
    function createNonFungibleToken(
        HederaToken memory token
    ) external payable returns (int64 responseCode, address tokenAddress);

    /// @notice Creates a non-fungible token with custom fees. The creation fee is paid with `msg.value`.
    /// @return responseCode `22` on success.
    /// @return tokenAddress Address of the new token.
    function createNonFungibleTokenWithCustomFees(
        HederaToken memory token,
        FixedFee[] memory fixedFees,
        RoyaltyFee[] memory royaltyFees
    ) external payable returns (int64 responseCode, address tokenAddress);

    /// @notice Mints to the treasury. The caller must hold the supply key.
    /// @param amount Zero for a non-fungible token: one serial is minted per `metadata` entry.
    /// @param metadata One entry per serial, at most 100 bytes each and at most 10 entries per call.
    /// @return responseCode `22` on success.
    /// @return newTotalSupply Supply after the mint.
    /// @return serialNumbers Serials that were minted.
    function mintToken(
        address token,
        int64 amount,
        bytes[] memory metadata
    ) external returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    /// @notice Moves one serial. `recipient` must be associated with the token or have a free auto-association
    ///         slot.
    /// @return responseCode `22` on success.
    function transferNFT(
        address token,
        address sender,
        address recipient,
        int64 serialNumber
    ) external returns (int64 responseCode);
}
