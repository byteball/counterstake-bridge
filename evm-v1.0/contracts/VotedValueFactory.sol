// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Governance.sol";
import "./VotedValue.sol";
import "./VotedValueUint.sol";
import "./VotedValueUintArray.sol";
import "./VotedValueAddress.sol";

contract VotedValueFactory {

	address public votedValueUintMaster;
	address public votedValueUintArrayMaster;
	address public votedValueAddressMaster;

	constructor(address _votedValueUintMaster, address _votedValueUintArrayMaster, address _votedValueAddressMaster) {
		votedValueUintMaster = _votedValueUintMaster;
		votedValueUintArrayMaster = _votedValueUintArrayMaster;
		votedValueAddressMaster = _votedValueAddressMaster;
	}


	function createVotedValueUint(Governance governance, uint initial_value, function(uint) external validationCallback, function(uint) external commitCallback) external returns (VotedValueUint) {
		VotedValueUint vv = VotedValueUint(Clones.clone(votedValueUintMaster));
		vv.init(governance, initial_value, validationCallback, commitCallback);
		return vv;
	}

	function createVotedValueUintArray(Governance governance, uint[] memory initial_value, function(uint[] memory) external validationCallback, function(uint[] memory) external commitCallback) external returns (VotedValueUintArray) {
		VotedValueUintArray vv = VotedValueUintArray(Clones.clone(votedValueUintArrayMaster));
		vv.init(governance, initial_value, validationCallback, commitCallback);
		return vv;
	}

	function createVotedValueAddress(Governance governance, address initial_value, function(address) external validationCallback, function(address) external commitCallback) external returns (VotedValueAddress) {
		VotedValueAddress vv = VotedValueAddress(Clones.clone(votedValueAddressMaster));
		vv.init(governance, initial_value, validationCallback, commitCallback);
		return vv;
	}

}
