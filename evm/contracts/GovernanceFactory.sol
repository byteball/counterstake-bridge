// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Governance.sol";
import "./VotedValue.sol";

contract GovernanceFactory {

	address public immutable governanceMaster;

	constructor(address _governanceMaster) {
		governanceMaster = _governanceMaster;
	}

	function createGovernance(address governedContractAddress, address votingTokenAddress) external returns (Governance) {
		Governance governance = Governance(Clones.clone(governanceMaster));
		governance.init(governedContractAddress, votingTokenAddress);
		return governance;
	}

}
