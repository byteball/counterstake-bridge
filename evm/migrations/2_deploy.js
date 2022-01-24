const Export = artifacts.require('Export');
const Import = artifacts.require('Import');
const Governance = artifacts.require('Governance');
const GovernanceFactory = artifacts.require('GovernanceFactory');
const VotedValueUint = artifacts.require('VotedValueUint');
const VotedValueUintArray = artifacts.require('VotedValueUintArray');
const VotedValueAddress = artifacts.require('VotedValueAddress');
const VotedValueFactory = artifacts.require('VotedValueFactory');
const CounterstakeLibrary = artifacts.require('CounterstakeLibrary');
const CounterstakeFactory = artifacts.require('CounterstakeFactory');
const ExportAssistant = artifacts.require('ExportAssistant');
const ImportAssistant = artifacts.require('ImportAssistant');
const AssistantFactory = artifacts.require('AssistantFactory');
const Oracle = artifacts.require('Oracle');
const { BN, ether, constants } = require('@openzeppelin/test-helpers');

module.exports = async function (deployer, network, accounts) {
	console.log('accounts', accounts);
	await deployer.deploy(CounterstakeLibrary);
	await deployer.link(CounterstakeLibrary, Export);
	await deployer.link(CounterstakeLibrary, Import);

	await deployer.link(CounterstakeLibrary, ExportAssistant);
	await deployer.link(CounterstakeLibrary, ImportAssistant);


	// Voted values

	await deployer.deploy(VotedValueUint);
	const votedValueUint = await VotedValueUint.deployed();
	console.log('VotedValueUint master address', votedValueUint.address);

	await deployer.deploy(VotedValueUintArray);
	const votedValueUintArray = await VotedValueUintArray.deployed();
	console.log('votedValueUintArray master address', votedValueUintArray.address);

	await deployer.deploy(VotedValueAddress);
	const votedValueAddress = await VotedValueAddress.deployed();
	console.log('VotedValueAddress master address', votedValueAddress.address);

	await deployer.deploy(VotedValueFactory, votedValueUint.address, votedValueUintArray.address, votedValueAddress.address);
	const votedValueFactory = await VotedValueFactory.deployed();
	console.log('VotedValueFactory address', votedValueFactory.address);


	// Governance

	// just any governed address will do for the master contract, use the address of counterstake library
	await deployer.deploy(Governance, CounterstakeLibrary.address, constants.ZERO_ADDRESS);
	const governance = await Governance.deployed();
	console.log('Governance master address', governance.address);

	await deployer.deploy(GovernanceFactory, governance.address);
	const governanceFactory = await GovernanceFactory.deployed();
	console.log('GovernanceFactory address', governanceFactory.address);

	
	// Oracle

	await deployer.deploy(Oracle);
	const oracle = await Oracle.deployed();
	console.log('Orcacle address', oracle.address);
	await oracle.setPrice("master", "_NATIVE_", 30, 1500);

	
	// Bridges

	// export
	await deployer.deploy(Export, "Obyte", "OETHasset", constants.ZERO_ADDRESS, 160, 110, ether('100'), [14*3600, 3*24*3600, 7*24*3600, 30*24*3600], [4*24*3600, 7*24*3600, 30*24*3600]);
	const ex = await Export.deployed();
	console.log('export master address', ex.address);

	// import
	await deployer.deploy(Import, "Obyte", "master", "Imported GBYTE", "GBYTE", constants.ZERO_ADDRESS, oracle.address, 160, 110, ether('100'), [14*3600, 3*24*3600, 7*24*3600, 30*24*3600], [4*24*3600, 7*24*3600, 30*24*3600]);
	const im = await Import.deployed();
	console.log('import master address', im.address);

	// counterstake factory
	await deployer.deploy(CounterstakeFactory, ex.address, im.address, governanceFactory.address, votedValueFactory.address);
	console.log(`deployed counterstake factory at address`, (await CounterstakeFactory.deployed()).address);


	// Assistants

	// export assistant
	await deployer.deploy(ExportAssistant, ex.address, constants.ZERO_ADDRESS, 100, 2000, constants.ZERO_ADDRESS, 1, "Export assistant template", "EXAS");
	const exas = await ExportAssistant.deployed();
	console.log('export assistant master address', exas.address);

	// import assistant
	await deployer.deploy(ImportAssistant, im.address, constants.ZERO_ADDRESS, 100, 2000, 10, 1, "Import assistant template", "IMAS");
	const imas = await ImportAssistant.deployed();
	console.log('import assistant master address', imas.address);

	// assistant factory
	await deployer.deploy(AssistantFactory, exas.address, imas.address, governanceFactory.address, votedValueFactory.address);
	console.log(`deployed assistant factory at address`, (await AssistantFactory.deployed()).address);

};
