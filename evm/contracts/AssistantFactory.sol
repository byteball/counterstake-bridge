// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./ExportAssistant.sol";
import "./ImportAssistant.sol";
import "./CounterstakeLibrary.sol";
import "./VotedValueFactory.sol";


contract AssistantFactory {

	event NewExportAssistant(address contractAddress, address bridgeAddress, address manager, string symbol);
	event NewImportAssistant(address contractAddress, address bridgeAddress, address manager, string symbol);

	address public immutable exportAssistantMaster;
	address public immutable importAssistantMaster;

	GovernanceFactory private immutable governanceFactory;
	VotedValueFactory private immutable votedValueFactory;

	constructor(address _exportAssistantMaster, address _importAssistantMaster, GovernanceFactory _governanceFactory, VotedValueFactory _votedValueFactory) {
		exportAssistantMaster = _exportAssistantMaster;
		importAssistantMaster = _importAssistantMaster;
		governanceFactory = _governanceFactory;
		votedValueFactory = _votedValueFactory;
	}

	function createExportAssistant(
		address bridgeAddr, address managerAddr, uint16 _management_fee10000, uint16 _success_fee10000, uint8 _exponent, string memory name, string memory symbol
	) external returns (ExportAssistant exportAssistant) {
		exportAssistant = ExportAssistant(payable(Clones.clone(exportAssistantMaster)));
		exportAssistant.initExportAssistant(bridgeAddr, managerAddr, _management_fee10000, _success_fee10000, _exponent, name, symbol);
		exportAssistant.setupGovernance(governanceFactory, votedValueFactory);
		emit NewExportAssistant(address(exportAssistant), bridgeAddr, managerAddr, symbol);
	}

	function createImportAssistant(
		address bridgeAddr, address managerAddr, uint16 _management_fee10000, uint16 _success_fee10000, uint16 _swap_fee10000, uint8 _exponent, string memory name, string memory symbol
	) external returns (ImportAssistant importAssistant) {
		importAssistant = ImportAssistant(payable(Clones.clone(importAssistantMaster)));
		importAssistant.initImportAssistant(bridgeAddr, managerAddr, _management_fee10000, _success_fee10000, _swap_fee10000, _exponent, name, symbol);
		importAssistant.setupGovernance(governanceFactory, votedValueFactory);
		emit NewImportAssistant(address(importAssistant), bridgeAddr, managerAddr, symbol);
	}


}

