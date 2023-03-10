"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const desktopApp = require("ocore/desktop_app.js");
const { getProvider } = require("./provider.js");
const { wait } = require('../utils.js');

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
	Polygon: {
		symbol: 'MATIC',
		price: 1,
	},
	Kava: {
		symbol: 'KAVA',
		price: 1,
	},
};

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

const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';
//const evmNetwork = 'Polygon';
//const evmNetwork = 'Kava';

const evmNativePrice = evmProps[evmNetwork].price;


const provider = getProvider(evmNetwork);
const ethWallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
console.error(`====== my ETH address on ${evmNetwork}: `, ethWallet.address);
const signer = process.env.devnet ? provider.getSigner(0) : ethWallet.connect(provider);




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
	const res = await oracle.setPrice(asset, "_NATIVE_", price_in_usd, evmNativePrice);
	console.error(res);
	await wait(2000);

	console.error('done');
	process.exit();
}

start();


