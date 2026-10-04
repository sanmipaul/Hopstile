// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

/// @title IHRC719
/// @notice Association functions every HTS token exposes at its own address (HIP-719).
/// @dev An account calls these on the token address to opt in or out of holding the token.
interface IHRC719 {
    /// @return responseCode `22` on success.
    function associate() external returns (uint256 responseCode);

    /// @return responseCode `22` on success.
    function dissociate() external returns (uint256 responseCode);

    /// @return associated Whether the caller is associated with the token.
    function isAssociated() external view returns (bool associated);
}
