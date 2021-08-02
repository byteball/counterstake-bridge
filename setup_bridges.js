"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const rpc = require('json-rpc2');
const conf = require('ocore/conf.js');
const desktopApp = require("ocore/desktop_app.js");
const db = require('ocore/db.js');
const network = require('ocore/network.js');
const eventBus = require('ocore/event_bus.js');
const headlessWallet = require('headless-obyte');
const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const db_import = require('./db_import.js');
const transfers = require('./transfers.js');
const webserver = require('./webserver.js');
const { getProvider } = require("./evm/provider.js");

const exportJson = require('./evm/build/contracts/Export.json');
const importJson = require('./evm/build/contracts/Import.json');
const tokenJson = require('./evm/build/contracts/Token.json');
const factoryJson = require('./evm/build/contracts/CounterstakeFactory.json');
const assistantFactoryJson = require('./evm/build/contracts/AssistantFactory.json');
const oracleJson = require('./evm/build/contracts/Oracle.json');

const { utils: { parseEther, parseUnits }, constants: { AddressZero } } = ethers;

const bWithAssistants = true;

const opts = {
//	gasPrice: 3e9
};

const evmProps = {
	Ethereum: {
		symbol: 'ETH',
		price: 2000,
		decimals_on_obyte: 8,
		large_threshold: parseEther('100'),
		stablecoinSymbol: 'USDC', // get testnet USDC from https://app.compound.finance/
		stablecoinTokenAddress: process.env.testnet ? '0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b' : '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		stablecoinDecimals: 6,
		factory: conf.ethereum_factory_contract_address,
		assistant_factory: conf.ethereum_assistant_factory_contract_address,
	},
	BSC: {
		symbol: 'BNB',
		price: 300,
		decimals_on_obyte: 8,
		large_threshold: parseEther('1000'),
		stablecoinSymbol: 'BUSD', // get testnet BUSD https://testnet.binance.org/faucet-smart
		stablecoinTokenAddress: process.env.testnet ? '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee' : '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 
		stablecoinDecimals: 18,
		factory: conf.bsc_factory_contract_address,
		assistant_factory: conf.bsc_assistant_factory_contract_address,
	},
	Polygon: {
		symbol: 'MATIC',
		price: 1,
		decimals_on_obyte: 5,
		large_threshold: parseEther('100000'),
		stablecoinSymbol: '',
		stablecoinTokenAddress: process.env.testnet ? '' : '', 
		stablecoinDecimals: 18,
		factory: conf.polygon_factory_contract_address,
		assistant_factory: conf.polygon_assistant_factory_contract_address,
	},
};

const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';
//const evmNetwork = 'Polygon';

const evmNativeSymbol = evmProps[evmNetwork].symbol;
const evmNativePrice = evmProps[evmNetwork].price;
const evmNativeDecimalsOnObyte = evmProps[evmNetwork].decimals_on_obyte;
const evmNativeLargeThreshold = evmProps[evmNetwork].large_threshold;
const evmStablecoinSymbol = evmProps[evmNetwork].stablecoinSymbol;
const evmStablecoinTokenAddress = evmProps[evmNetwork].stablecoinTokenAddress;
const evmStablecoinDecimals = evmProps[evmNetwork].stablecoinDecimals;

// for devnet only
const metamaskAddress = '0xbd2C1400eA794D837669d3A83Ef8B3534579b5BF';
const obyteWalletAddress = 'EKOGTLLPBUB6TWWHRE2X5KLA65UOUPPP';
let signerNum = 0;


const obyte_oracle = process.env.devnet ? 'ZQFHJXFWT2OCEBXF26GFXJU4MPASWPJT' : (process.env.testnet ? 'F4KHJUCLJKY4JV7M5F754LAJX4EB7M4N' : 'JPQKPRI5FMTQRJF4ZZMYZYDQVRD55OTC');

const symbol_suffix = '';

const obyte_challenging_periods = (process.env.devnet || process.env.testnet) ? '0.1 0.2 0.5 1' : '72 168 720 1440';
const obyte_large_challenging_periods = (process.env.devnet || process.env.testnet) ? '0.2 0.3 0.7 1.5' : '168 720 1440 2160';

const ethereum_challenging_periods = (process.env.devnet || process.env.testnet) ? [0.1 * 3600, 0.2 * 3600, 0.5 * 3600, 1 * 3600] : [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, 60 * 24 * 3600];
const ethereum_long_challenging_periods = (process.env.devnet || process.env.testnet) ? [0.2 * 3600, 0.3 * 3600, 0.7 * 3600, 1.5 * 3600] : [7 * 24 * 3600, 30 * 24 * 3600, 60 * 24 * 3600, 90 * 24 * 3600];

let providers = {};
providers.Ethereum = getProvider('Ethereum');
providers.BSC = getProvider('BSC');
providers.Polygon = getProvider('Polygon');

const provider = providers[evmNetwork];
const ethWallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
console.error(`====== my ETH address: `, ethWallet.address);
const signer = process.env.devnet ? provider.getSigner(0) : ethWallet.connect(provider);



let aas = [
	'export-governance.oscript',
	'import-governance.oscript',
	'assistant-governance.oscript',
	'export.oscript',
	'import.oscript',
	'export-assistant.oscript',
	'import-assistant.oscript',
	'export-assistant-factory.oscript',
	'import-assistant-factory.oscript',
	'export-factory.oscript',
	'import-factory.oscript',
];
if (process.env.devnet)
	aas.unshift('../token-registry-aa/token-registry.oscript');
const deploymentDependencies = {
	'export-factory.oscript': ['export-governance.oscript'],
	'import-factory.oscript': ['import-governance.oscript'],
};
let deploymentUnits = {};


async function deployAA(filename) {
	const unit = await dag.deployAAFromFile('./aas/' + filename);
	console.error(`deployed ${filename} in tx ${unit}`);
	await wait(1000);
	return unit;
}

async function waitForDeploymentDependencies(aa) {
	const dependencies = deploymentDependencies[aa];
	if (!dependencies || dependencies.length === 0)
		return;
	for (let dependency_aa of dependencies) {
		const dependency_unit = deploymentUnits[dependency_aa];
		if (!dependency_unit) {
			console.error(`dependency AA ${dependency_aa} was already deployed`);
			continue;
		}
		console.error(`waiting for stability of ${dependency_aa} unit ${dependency_unit}`);
		await headlessWallet.waitUntilMyUnitBecameStable(dependency_unit);
		console.error(`${dependency_unit} is stable`);
	}
}

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function push() {
	const unit = await dag.sendPayment({ to_address: operator.getAddress(), amount: 5e5 });
	console.error(`pushed ${unit}`);
}

function sendBytesFromWitness(address, amount, cb) {
	if (!cb)
		return new Promise((resolve, reject) => sendBytesFromWitness(address, amount, (err, res) => err ? reject(err) : resolve(res)));
	const client = rpc.Client.$create(6612, '127.0.0.1');
	client.call('sendtoaddress', [address, amount], cb);
}

function assertValidEthereumAddress(address) {
	if (address.length !== 42 || address !== ethers.utils.getAddress(address))
		throw Error(`invalid address ${address}`);
}

async function sendEtherFromGanache(address, amount) {
	signerNum++;
	const signer = provider.getSigner(signerNum);
	const res = await signer.sendTransaction({ to: address, value: amount });
	console.error('sendEther res', res);
}

async function createEthereumToken() {
	const tokenFactory = ethers.ContractFactory.fromSolidity(tokenJson, signer);
	const usdc = await tokenFactory.deploy('USDC stablecoin', 'USDC');
	console.error('usdc', usdc.address);
	return usdc.address;
}

async function sendToken(tokenAddress, address, amount) {
	assertValidEthereumAddress(tokenAddress);
	assertValidEthereumAddress(address);
	const contract = new ethers.Contract(tokenAddress, tokenJson.abi, signer);
	const res = await contract.mint(address, amount);
	console.error('sendToken res', res);
}

async function createObyteImport(home_asset, home_symbol, asset_decimals, oracles, large_threshold) {
	assertValidEthereumAddress(home_asset);
	const unit = await dag.sendAARequest(conf.import_factory_aa, {
		home_network: evmNetwork,
		home_asset,
		stake_asset: 'base',
		stake_asset_decimals: 9,
		asset_decimals,
		challenging_periods: obyte_challenging_periods,
		large_challenging_periods: obyte_large_challenging_periods,
		large_threshold,
		min_stake: 1e9,
		min_tx_age: 30,
		oracles,
	});
	console.error(`waiting for AA response from create import trigger ${unit}`);
	const response = await dag.getAAResponseToTrigger(conf.import_factory_aa, unit);
	if (response.bounced)
		throw Error(`createObyteImport ${home_symbol} bounced: ${response.response.error}`);
	const address = response.response.responseVars.address;
	const asset = await dag.readAAStateVar(address, 'asset');
	await registerObyteToken(asset, home_symbol + symbol_suffix, asset_decimals, home_symbol + ' on Obyte');
	return { address, asset };
}

async function createObyteExport(foreign_asset, asset, asset_decimals, large_threshold, min_stake) {
	assertValidEthereumAddress(foreign_asset);
	const unit = await dag.sendAARequest(conf.export_factory_aa, {
		foreign_network: evmNetwork,
		foreign_asset,
		asset,
		asset_decimals,
		challenging_periods: obyte_challenging_periods,
		large_challenging_periods: obyte_large_challenging_periods,
		large_threshold,
		min_stake,
		min_tx_age: 30,
	});
	console.error(`waiting for AA response from create export trigger ${unit}`);
	const response = await dag.getAAResponseToTrigger(conf.export_factory_aa, unit);
	if (response.bounced)
		throw Error(`createObyteExport ${asset} bounced: ${response.response.error}`);
	const address = response.response.responseVars.address;
	return address;
}

async function createObyteExportAssistant(bridge_aa, symbol, asset_decimals) {
	if (!bWithAssistants)
		return;
	const unit = await dag.sendAARequest(conf.export_assistant_factory_aa, {
		bridge_aa,
		manager: operator.getAddress(),
		management_fee: 0.01,
		success_fee: 0.1,
	});
	console.error(`waiting for AA response from create export assistant trigger ${unit}`);
	const response = await dag.getAAResponseToTrigger(conf.export_assistant_factory_aa, unit);
	if (response.bounced)
		throw Error(`createObyteExportAssistant ${symbol} bounced: ${response.response.error}`);
	const address = response.response.responseVars.address;
	const shares_asset = await dag.readAAStateVar(address, 'shares_asset');
	await registerObyteToken(shares_asset, `${symbol}${evmNetwork.substr(0, 1).toUpperCase()}EA`, asset_decimals, `${symbol} export assistant shares`);
}

async function createObyteImportAssistant(bridge_aa, symbol, asset_decimals) {
	if (!bWithAssistants)
		return;
	const unit = await dag.sendAARequest(conf.import_assistant_factory_aa, {
		bridge_aa,
		manager: operator.getAddress(),
		management_fee: 0.01,
		success_fee: 0.1,
		swap_fee: 0.001,
	});
	console.error(`waiting for AA response from create import assistant trigger ${unit}`);
	const response = await dag.getAAResponseToTrigger(conf.import_assistant_factory_aa, unit);
	if (response.bounced)
		throw Error(`createObyteImportAssistant ${symbol} bounced: ${response.response.error}`);
	const address = response.response.responseVars.address;
	const shares_asset = await dag.readAAStateVar(address, 'shares_asset');
	await registerObyteToken(shares_asset, `${symbol}${symbol_suffix}IA`, asset_decimals, `${symbol} import assistant shares`);
}

async function createEvmExport(foreign_asset, home_token, large_threshold, home_network, foreign_network) {
	const factory = new ethers.Contract(evmProps[home_network].factory, factoryJson.abi, ethWallet.connect(providers[home_network]));
	const res = await factory.createExport(foreign_network, foreign_asset, home_token, 150, 100, large_threshold, ethereum_challenging_periods, ethereum_long_challenging_periods, opts);
	console.error(`createEthereumExport ${home_token} => ${foreign_asset} res`, res);
	const receipt = await res.wait();
	console.error(`createEthereumExport ${home_token} => ${foreign_asset} mined`);
	const contractAddress = receipt.events[0].args.contractAddress;
	if (!contractAddress)
		throw Error(`no contract address in event args ${receipt.events[0].args}`);
	return contractAddress;
}

async function createEvmImport(home_asset, symbol, large_threshold, oracleAddress, home_network, foreign_network) {
	const factory = new ethers.Contract(evmProps[foreign_network].factory, factoryJson.abi, ethWallet.connect(providers[foreign_network]));
	const res = await factory.createImport(home_network, home_asset, "Imported " + symbol, symbol, AddressZero, oracleAddress, 150, 100, large_threshold, ethereum_challenging_periods, ethereum_long_challenging_periods, opts);
	console.error(`createEthereumImport ${home_asset} => ${symbol} res`, res);
	const receipt = await res.wait();
	console.error(`createEthereumImport ${home_asset} => ${symbol} mined`);
	const contractAddress = receipt.events[0].args.contractAddress;
	if (!contractAddress)
		throw Error(`no contract address in event args ${receipt.events[0].args}`);
	return contractAddress;
}


async function createEvmExportAssistant(bridge_aa, symbol, network) {
	if (!bWithAssistants)
		return;
	const factory = new ethers.Contract(evmProps[network].assistant_factory, assistantFactoryJson.abi, ethWallet.connect(providers[network]));
	const res = await factory.createExportAssistant(bridge_aa, ethWallet.address, 100, 1000, 1, `${symbol} export assistant shares`, `${symbol}EA`, opts);
	console.error(`createEthereumExportAssistant ${symbol} res`, res);
	await res.wait();
	await wait(5000);
}

async function createEvmImportAssistant(bridge_aa, symbol, network) {
	if (!bWithAssistants)
		return;
	const factory = new ethers.Contract(evmProps[network].assistant_factory, assistantFactoryJson.abi, ethWallet.connect(providers[network]));
	const res = await factory.createImportAssistant(bridge_aa, ethWallet.address, 100, 1000, 10, 1, `${symbol} import assistant shares`, `${symbol}IA`, opts);
	console.error(`createEthereumImportAssistant ${symbol} res`, res);
	await res.wait();
	await wait(5000);
}


async function createEvmOracle(network) {
	console.error(`deploying oracle on ${network}`);
	const oracleFactory = ethers.ContractFactory.fromSolidity(oracleJson, ethWallet.connect(providers[network]));
	const oracle = await oracleFactory.deploy(opts);
	console.error(evmNetwork, 'oracle', oracle.address);
	await oracle.deployTransaction.wait();
	await wait(5000);
	return oracle;
}



async function registerObyteToken(asset, symbol, decimals, description) {
	return await dag.sendPayment({
		to_address: conf.token_registry_aa,
		amount: 0.1e9,
		data: { asset, symbol, decimals, description },
		is_aa: true,
	});
}



process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});


async function init() {
	await headlessWallet.waitTillReady();
	await db_import.initDB();
	await operator.start();
	network.start();
}

async function setupInitialBridges() {
	await init();

	if (process.env.devnet) {
		await sendBytesFromWitness(operator.getAddress(), 200e9);
		await sendBytesFromWitness(obyteWalletAddress, 200e9);

		await sendEtherFromGanache(metamaskAddress, parseEther('90'));
		await sendEtherFromGanache(ethWallet.address, parseEther('50'));
	}

	await wait(1000);
	for (let aa of aas) {
		await waitForDeploymentDependencies(aa);
		deploymentUnits[aa] = await deployAA(aa);
	}

	await transfers.start();
	webserver.start();

	// USDC on Ethereum
	let usdcTokenAddress;
	let usdcDecimals;
	if (process.env.devnet) {
		usdcTokenAddress = await createEthereumToken();
		usdcDecimals = 18;
		await sendToken(usdcTokenAddress, metamaskAddress, parseEther('10000'));
		await sendToken(usdcTokenAddress, ethWallet.address, parseEther('10000'));
	}
	else {
		usdcTokenAddress = evmStablecoinTokenAddress;
		usdcDecimals = evmStablecoinDecimals;
	}

	// OUSD on Obyte
	let ousdAsset;
	if (process.env.devnet) {
		ousdAsset = await dag.defineAsset();
		await headlessWallet.waitUntilMyUnitBecameStable(ousdAsset);
		await registerObyteToken(ousdAsset, 'OUSD', 4, 'OUSD stablecoin');
		await dag.sendPayment({ to_address: obyteWalletAddress, asset: ousdAsset, amount: 1000000e4 });
	}
	else
		ousdAsset = process.env.testnet ? 'CPPYMBzFzI4+eMk7tLMTGjLF4E60t5MUfo2Gq7Y6Cn4=' : '0IwAk71D5xFP0vTzwamKBwzad3I1ZUjZ1gdeB5OnfOg=';
	
	// oracle
	const oracle = await createEvmOracle(evmNetwork);
	const oracleAddress = oracle.address;
	let res = await oracle.setPrice("Obyte", "_NATIVE_", 25, evmNativePrice);
	await res.wait();
	await wait(5000);
	res = await oracle.setPrice(ousdAsset, "_NATIVE_", 1, evmNativePrice);
	await res.wait();
	await wait(5000);

	if (process.env.testnet)
		setInterval(push, 4000);

	// ETH: Ethereum -> Obyte
	const { address: eth_import_aa, asset: eth_on_obyte } = await createObyteImport(AddressZero, evmNativeSymbol, evmNativeDecimalsOnObyte, `${obyte_oracle}*${evmNativeSymbol}_USD ${obyte_oracle}/GBYTE_USD`, 1000e9);
	await createObyteImportAssistant(eth_import_aa, evmNativeSymbol, evmNativeDecimalsOnObyte);
	const eth_export_aa = await createEvmExport(eth_on_obyte, AddressZero, evmNativeLargeThreshold, evmNetwork, "Obyte");
	await wait(5000);
	await createEvmExportAssistant(eth_export_aa, evmNativeSymbol, evmNetwork);

	// GBYTE: Obyte -> Ethereum
	const gbyte_on_eth = await createEvmImport('base', 'GBYTE', evmNativeLargeThreshold, oracleAddress, "Obyte", evmNetwork);
	await wait(5000);
	await createEvmImportAssistant(gbyte_on_eth, 'GBYTE', evmNetwork);
	const gbyte_export_aa = await createObyteExport(gbyte_on_eth, 'base', 9, 1000e9, 1e9);
	await createObyteExportAssistant(gbyte_export_aa, 'GBYTE', 9);

	// USDC: Ethereum -> Obyte
	const { address: usdc_import_aa, asset: usdc_on_obyte } = await createObyteImport(usdcTokenAddress, evmStablecoinSymbol, 4, `${obyte_oracle}/GBYTE_USD`, 1000e9);
	await createObyteImportAssistant(usdc_import_aa, evmStablecoinSymbol, 4);
	// the large threshold is lower because the watchdogs might not have enough USDC readily available to challenge fraudulent claims
	const usdc_export_aa = await createEvmExport(usdc_on_obyte, usdcTokenAddress, parseUnits('20000', usdcDecimals), evmNetwork, "Obyte");
	await wait(5000);
	await createEvmExportAssistant(usdc_export_aa, evmStablecoinSymbol, evmNetwork);

	// OUSD: Obyte -> Ethereum
	const ousd_on_eth = await createEvmImport(ousdAsset, 'OUSD', evmNativeLargeThreshold, oracleAddress, "Obyte", evmNetwork);
	await wait(5000);
	await createEvmImportAssistant(ousd_on_eth, 'OUSD', evmNetwork);
	// the large threshold is lower because the watchdogs might not have enough OUSD readily available to challenge fraudulent claims
	const ousd_export_aa = await createObyteExport(ousd_on_eth, ousdAsset, 4, 20000e4, 100e4);
	await createObyteExportAssistant(ousd_export_aa, 'OUSD', 4);

	console.error('done');
	await wait(1000);
	process.exit();
}



async function setupEvm2ObyteBridge(tokenAddress, symbol, ethereum_decimals, obyte_decimals, large_threshold) {
	assertValidEthereumAddress(tokenAddress);
	const { address: import_aa, asset: asset_on_obyte } = await createObyteImport(tokenAddress, symbol, obyte_decimals, `${obyte_oracle}*${symbol}_USD ${obyte_oracle}/GBYTE_USD`, 1000e9);
	await createObyteImportAssistant(import_aa, symbol, obyte_decimals);
	const export_aa = await createEvmExport(asset_on_obyte, tokenAddress, parseUnits(large_threshold + '', ethereum_decimals), evmNetwork, "Obyte");
	await wait(2000);
	await createEvmExportAssistant(export_aa, symbol, evmNetwork);
}

const oracleAddresses = process.env.testnet
	? {
		Ethereum: '0x1Af68677849da73B62A91d775B6A2bF457c0B2e3',
		BSC: '0x3d2cd866b2e2e4fCE1dCcf662E71ea9611113344',
		Polygon: '0x7A5b663D4Be50E415803176d9f473ee81db590b7',
	}
	: {
		Ethereum: '0xAC4AA997A171A6CbbF5540D08537D5Cb1605E191',
		BSC: '0xdD52899A001a4260CDc43307413A5014642f37A2',
		Polygon: '0xdd603Fc2312A0E7Ab01dE2dA83e7776Af406DCeB',
	};

async function setupObyte2EvmBridge(asset, symbol, obyte_decimals, large_threshold, min_stake, price_in_usd) {
	const oracleAddress = oracleAddresses.Ethereum;
	const oracle = new ethers.Contract(oracleAddress, oracleJson.abi, signer);
	const res = await oracle.setPrice(asset, "_NATIVE_", price_in_usd, evmNativePrice);
	await res.wait();
	await wait(2000);

	const token_on_eth = await createEvmImport(asset, symbol, evmNativeLargeThreshold, oracleAddress, "Obyte", evmNetwork);
	await wait(2000);
	await createEvmImportAssistant(token_on_eth, symbol, evmNetwork);
	const export_aa = await createObyteExport(token_on_eth, asset, obyte_decimals, large_threshold, min_stake);
	await createObyteExportAssistant(export_aa, symbol, obyte_decimals);
}

async function setupBSC2EthereumBridge(tokenAddress, symbol, bsc_decimals, large_threshold, price_in_usd) {
	assertValidEthereumAddress(tokenAddress);
	const oracleAddress = oracleAddresses.Ethereum;
	const oracle = new ethers.Contract(oracleAddress, oracleJson.abi, ethWallet.connect(providers.Ethereum));
	const res = await oracle.setPrice(tokenAddress, "_NATIVE_", price_in_usd, evmProps.Ethereum.price);
	await res.wait();
	await wait(2000);

	const token_on_eth = await createEvmImport(tokenAddress, symbol, evmProps.Ethereum.large_threshold, oracleAddress, 'BSC', 'Ethereum');
	await wait(2000);
	await createEvmImportAssistant(token_on_eth, symbol, 'Ethereum');
	const export_aa = await createEvmExport(token_on_eth, tokenAddress, parseUnits(large_threshold + '', bsc_decimals), 'BSC', 'Ethereum');
	await wait(2000);
	await createEvmExportAssistant(export_aa, symbol, 'BSC');
}

async function setupEthereum2BSCBridge(tokenAddress, symbol, ethereum_decimals, large_threshold, price_in_usd) {
	assertValidEthereumAddress(tokenAddress);
	const oracleAddress = oracleAddresses.BSC;
	const oracle = new ethers.Contract(oracleAddress, oracleJson.abi, ethWallet.connect(providers.BSC));
	const res = await oracle.setPrice(tokenAddress, "_NATIVE_", price_in_usd, evmProps.BSC.price);
	await res.wait();
	await wait(2000);

	const token_on_bsc = await createEvmImport(tokenAddress, symbol, evmProps.BSC.large_threshold, oracleAddress, 'Ethereum', 'BSC');
	await wait(2000);
	await createEvmImportAssistant(token_on_bsc, symbol, 'BSC');
	const export_aa = await createEvmExport(token_on_bsc, tokenAddress, parseUnits(large_threshold + '', ethereum_decimals), 'Ethereum', 'BSC');
	await wait(2000);
	await createEvmExportAssistant(export_aa, symbol, 'Ethereum');
}

async function setupAdditionalBridge() {
	await init();
	await transfers.start();
	webserver.start();
	await setupEvm2ObyteBridge('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 8, 8, 0.5);
//	await setupObyte2EvmBridge('RGJT5nS9Luw2OOlAeOGywxbxwWPXtDAbZfEw5PiXVug=', 'IBIT', 8, 1e8, 1e5, 40e3);
//	await setupBSC2EthereumBridge(evmProps.BSC.stablecoinTokenAddress, 'BUSD', 18, 20000, 1);
//	await setupEthereum2BSCBridge(evmProps.Ethereum.stablecoinTokenAddress, 'USDC', 6, 20000, 1);
	console.error('done');
	await wait(2000);
	process.exit();
}

//setupInitialBridges();
setupAdditionalBridge();
