// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;

interface IOracle {
	// returns a fraction num/den
	function getPrice(string memory base, string memory quote) external view returns (uint num, uint den);
}
