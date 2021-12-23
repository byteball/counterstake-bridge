// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Export.sol";
import "./Import.sol";
import "./CounterstakeLibrary.sol";
import "./VotedValueFactory.sol";


contract CounterstakeFactory {

	event NewExport(address contractAddress, address tokenAddress, string foreign_network, string foreign_asset);
	event NewImport(address contractAddress, string home_network, string home_asset, string symbol, address stakeTokenAddress);

	uint[] private default_challenging_periods = [72 hours, 7 days, 30 days, 60 days];
	uint[] private default_large_challenging_periods = [1 weeks, 30 days, 60 days];

	address public immutable exportMaster;
	address public immutable importMaster;

	GovernanceFactory immutable governanceFactory;
	VotedValueFactory immutable votedValueFactory;

	constructor(address _exportMaster, address _importMaster, GovernanceFactory _governanceFactory, VotedValueFactory _votedValueFactory) {
		exportMaster = _exportMaster;
		importMaster = _importMaster;
		governanceFactory = _governanceFactory;
		votedValueFactory = _votedValueFactory;
	}

	function createExport(
		string memory foreign_network, 
		string memory foreign_asset, 
		address tokenAddr, 
		uint16 counterstake_coef100, 
		uint16 ratio100, 
		uint large_threshold, 
		uint[] memory challenging_periods, 
		uint[] memory large_challenging_periods
	) external returns (Export) {
		Export export = Export(Clones.clone(exportMaster));
		export.initCounterstake(
			tokenAddr, 
			counterstake_coef100, 
			ratio100, 
			large_threshold, 
			challenging_periods.length > 0 ? challenging_periods : default_challenging_periods, 
			large_challenging_periods.length > 0 ? large_challenging_periods : default_large_challenging_periods
		);
		export.initExport(foreign_network, foreign_asset);
		export.setupGovernance(governanceFactory, votedValueFactory);
		emit NewExport(address(export), address(tokenAddr), foreign_network, foreign_asset);
		return export;
	}

	function createImport(
		string memory home_network,
		string memory home_asset,
		string memory name,
		string memory symbol,
		address stakeTokenAddr,
		address oracleAddr,
		uint16 counterstake_coef100,
		uint16 ratio100,
		uint large_threshold,
		uint[] memory challenging_periods,
		uint[] memory large_challenging_periods
	) external returns (Import) {
		Import im = Import(Clones.clone(importMaster));
		im.initCounterstake(
			stakeTokenAddr, 
			counterstake_coef100, 
			ratio100, 
			large_threshold, 
			challenging_periods.length > 0 ? challenging_periods : default_challenging_periods, 
			large_challenging_periods.length > 0 ? large_challenging_periods : default_large_challenging_periods
		);
		im.initImport(home_network, home_asset, name, symbol, oracleAddr);
		im.setupGovernance(governanceFactory, votedValueFactory);
		emit NewImport(address(im), home_network, home_asset, symbol, stakeTokenAddr);
		return im;
	}

}

