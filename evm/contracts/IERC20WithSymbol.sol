// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IERC20WithSymbol is IERC20 {
	function symbol() external view returns (string memory);
}
