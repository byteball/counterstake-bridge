// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/access/Ownable.sol";
import "./IOracle.sol";

contract Oracle is IOracle, Ownable {
	struct Fraction {
		uint num;
		uint den;
	}
	
	mapping(string => mapping(string => Fraction)) public prices;

	function getPrice(string memory base, string memory quote) public override view returns (uint num, uint den) {
		if (keccak256(abi.encodePacked(base)) == keccak256(abi.encodePacked(quote)))
			return (1, 1);
		Fraction storage price = prices[base][quote];
		if (price.num > 0)
			return (price.num, price.den);
		// try a reverse fraction
		price = prices[quote][base];
		if (price.num > 0)
			return (price.den, price.num);
		return (0, 0);
	}

	// zero den is ok - infinite price
	// both zeros: stopped trading, no price
	function setPrice(string memory base, string memory quote, uint num, uint den) onlyOwner public {
		Fraction storage reverse_price = prices[quote][base];
		bool reverse_price_exists = (reverse_price.num > 0 || reverse_price.den > 0);
		if (!reverse_price_exists)
			prices[base][quote] = Fraction({num: num, den: den});
		else
			prices[quote][base] = Fraction({num: den, den: num});
	}

}
