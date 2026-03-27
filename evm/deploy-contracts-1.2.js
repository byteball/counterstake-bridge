const fs = require("fs");
const { ethers } = require("ethers");
const desktopApp = require("ocore/desktop_app.js");
const { getProvider } = require("./provider.js");
const { wait } = require('../utils.js');

const CounterstakeLibrary = require('./build/contracts/CounterstakeLibrary.json');
const Export = require('./build/contracts/Export.json');
const Import = require('./build/contracts/Import.json');
const CounterstakeFactory = require('./build/contracts/CounterstakeFactory.json');
const ExportAssistant = require('./build/contracts/ExportAssistant.json');
const ImportAssistant = require('./build/contracts/ImportAssistant.json');
const AssistantFactory = require('./build/contracts/AssistantFactory.json');
const Governance = require('./build/contracts/Governance.json');
const GovernanceFactory = require('./build/contracts/GovernanceFactory.json');
const oracleJson = require('./build/contracts/Oracle.json');

const { utils: { parseEther }, constants: { AddressZero } } = ethers;

//const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';
//const evmNetwork = 'Polygon';
const evmNetwork = 'Kava';

const targetGasPrice = 35; // gwei

const opts = {
//	gasPrice: 8e9
};

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up);
	throw up;
});


function link(contractJson, libName, libAddress) {
	const symbol = "__" + libName + "_".repeat(40 - libName.length - 2);
	const re = new RegExp(symbol, 'g');
	libAddress = libAddress.toLowerCase().replace(/^0x/, '');
	contractJson.bytecode = contractJson.bytecode.replace(re, libAddress);
	contractJson.deployedBytecode = contractJson.deployedBytecode.replace(re, libAddress);
}

async function deploy() {

//	const { mnemonic, infura_project_id } = process.env;
	const mnemonic = JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase;

	const provider = getProvider(evmNetwork);
	
	const ethWallet = ethers.Wallet.fromMnemonic(mnemonic);
	console.error(`====== my ETH address on ${evmNetwork}: `, process.env.devnet ? await provider.getSigner().getAddress() : ethWallet.address);
	const signer = process.env.devnet ? provider.getSigner(0) : ethWallet.connect(provider);

	if (provider._websocket && !process.env.devnet) {
		provider.on('block', (blockNumber) => {
			console.log('got new block', blockNumber);
			provider._websocket.ping();
		});
	}


	async function createEvmOracle() {
		console.error(`deploying oracle on ${evmNetwork}`);
		const oracleFactory = ethers.ContractFactory.fromSolidity(oracleJson, ethWallet.connect(provider));
		const oracle = await oracleFactory.deploy(opts);
		console.error(evmNetwork, 'oracle', oracle.address);
		await oracle.deployTransaction.wait();
		console.log('mined');
		await wait(5000);
		return oracle;
	}
	
	async function getGasPrice() {
		return (await provider.getGasPrice()).toNumber() / 1e9;
	}

	async function waitForGasPrice() {
		while (true) {
			const gasPrice = await getGasPrice();
			console.log(`gas price`, gasPrice);
			if (gasPrice < targetGasPrice)
				break;
			await wait(60 * 1000);
		}
	}

	await waitForGasPrice();
	
	
	// oracle

	const oracleAddresses = process.env.testnet
		? {
			Ethereum: '0x1Af68677849da73B62A91d775B6A2bF457c0B2e3',
			BSC: '0x3d2cd866b2e2e4fCE1dCcf662E71ea9611113344',
			Polygon: '0x7A5b663D4Be50E415803176d9f473ee81db590b7',
			Kava: '0x5e4E4eA9C780b6dF0087b0052A7A1ad039F398bB',
		}
		: {
			Ethereum: '0xAC4AA997A171A6CbbF5540D08537D5Cb1605E191',
			BSC: '0xdD52899A001a4260CDc43307413A5014642f37A2',
			Polygon: '0xdd603Fc2312A0E7Ab01dE2dA83e7776Af406DCeB',
			Kava: '0x16f5E8ad38cf676a0a78436ED8F5C8c19dA3be3d',
		};

	const oracleAddress = oracleAddresses[evmNetwork];


	// Voted values

	const votedValueFactories = process.env.testnet
		? {}
		: {
			Ethereum: '0x5ADC92A6DA12DfB32aBC0305994ebB7BD453368b',
			BSC: '0x22d5F491C366B69B08AB6D19a8a1DeeC64b131f6',
			Polygon: '0x29Fb30C62005F1804D805Ff8D2b2b685c0978fFa',
			Kava: '0xA07Cb1aE29b2167146bd33601C4bf9288b68Cb95',
		};
	const votedValueFactoryAddress = votedValueFactories[evmNetwork];
	if (!votedValueFactoryAddress)
		throw new Error(`voted value factory address not set for ${evmNetwork}`);


	// Counterstake library

	const csLib = await ethers.ContractFactory.fromSolidity(CounterstakeLibrary, signer).deploy(opts);
	console.error('counterstake library', csLib.address);
	link(Export, 'CounterstakeLibrary', csLib.address);
	link(Import, 'CounterstakeLibrary', csLib.address);
	link(ExportAssistant, 'CounterstakeLibrary', csLib.address);
	await csLib.deployTransaction.wait();
	console.log('mined');
	await wait(2000);


	// Governance

	const governance = await ethers.ContractFactory.fromSolidity(Governance, signer).deploy(csLib.address, AddressZero, opts);
	console.log('Governance master address', governance.address);
	await governance.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	const governanceFactory = await ethers.ContractFactory.fromSolidity(GovernanceFactory, signer).deploy(governance.address, opts);
	console.log('GovernanceFactory address', governanceFactory.address);
	await governanceFactory.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	
	// Bridges

	// export
	const ex = await ethers.ContractFactory.fromSolidity(Export, signer).deploy("Obyte", "OETHasset", AddressZero, 160, 110, parseEther('100'), [14*3600, 3*24*3600, 7*24*3600, 30*24*3600], [4*24*3600, 7*24*3600, 30*24*3600], opts);
	console.log('export master address', ex.address);
	await ex.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	// import
	const im = await ethers.ContractFactory.fromSolidity(Import, signer).deploy("Obyte", "base", "Imported GBYTE master", "GBYTE_MASTER", AddressZero, oracleAddress, 160, 110, parseEther('100'), [14*3600, 3*24*3600, 7*24*3600, 30*24*3600], [4*24*3600, 7*24*3600, 30*24*3600], opts);
	console.log('import master address', im.address);
	await im.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	// counterstake factory
	const csFactory = await ethers.ContractFactory.fromSolidity(CounterstakeFactory, signer).deploy(ex.address, im.address, governanceFactory.address, votedValueFactoryAddress, opts);
	console.log(`deployed counterstake factory at address`, csFactory.address);
	await csFactory.deployTransaction.wait();
	console.log('mined');
	await wait(2000);


	// Assistants

	// export assistant
	const exas = await ethers.ContractFactory.fromSolidity(ExportAssistant, signer).deploy(ex.address, AddressZero, 100, 2000, AddressZero, 1, "Export assistant template", "EXAS", opts);
	console.log('export assistant master address', exas.address);
	await exas.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	// import assistant
	const imas = await ethers.ContractFactory.fromSolidity(ImportAssistant, signer).deploy(im.address, AddressZero, 100, 2000, 10, 1, "Import assistant template", "IMAS", opts);
	console.log('import assistant master address', imas.address);
	await imas.deployTransaction.wait();
	console.log('mined');
	await wait(2000);

	// assistant factory
	const assistantFactory = await ethers.ContractFactory.fromSolidity(AssistantFactory, signer).deploy(exas.address, imas.address, governanceFactory.address, votedValueFactoryAddress, opts);
	console.log(`deployed assistant factory at address`, assistantFactory.address);
	await assistantFactory.deployTransaction.wait();
	console.log('mined');
	await wait(2000);


	console.log('done');
	process.exit();
}


deploy();
