"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const desktopApp = require("ocore/desktop_app.js");

const oracleJson = require('./build/contracts/Oracle.json');

const evmProps = {
	Ethereum: {
		symbol: 'ETH',
		price: 2000,
	},
	BSC: {
		symbol: 'BNB',
		price: 300,
	},
};

const oracleAddresses = process.env.testnet
	? {
		Ethereum: '0x1Af68677849da73B62A91d775B6A2bF457c0B2e3',
		BSC: '0x3d2cd866b2e2e4fCE1dCcf662E71ea9611113344',
	}
	: {
		Ethereum: '0xAC4AA997A171A6CbbF5540D08537D5Cb1605E191',
		BSC: '0xdD52899A001a4260CDc43307413A5014642f37A2',
	};

const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';
const evmNativePrice = evmProps[evmNetwork].price;


const provider = process.env.devnet
	? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
	: (evmNetwork === 'Ethereum'
		? new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id)
		: new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org"));
const ethWallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
console.error(`====== my ETH address: `, ethWallet.address);
const signer = process.env.devnet ? provider.getSigner(0) : ethWallet.connect(provider);

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}




process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});


async function start() {

	// asset on Obyte
	let asset = '7kU/4vBq36C3Q53BX4C3lfOFFT20i/3SGBWATlpn+WU=';
	let price_in_usd = 30;
	
	// oracle
	const oracleAddress = oracleAddresses[evmNetwork];
	const oracle = new ethers.Contract(oracleAddress, oracleJson.abi, signer);
//	await oracle.setPrice("Obyte", "_NATIVE_", 50, evmNativePrice);
//	await wait(2000);
	await oracle.setPrice(asset, "_NATIVE_", price_in_usd, evmNativePrice);
	await wait(2000);

	console.error('done');
	process.exit();
}

start();


