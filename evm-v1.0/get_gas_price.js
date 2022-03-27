const fs = require("fs");
const { ethers } = require("ethers");
const desktopApp = require("ocore/desktop_app.js");
const { getProvider } = require("./provider.js");

const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';
//const evmNetwork = 'Polygon';

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

async function start() {

	const mnemonic = JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase;

	const provider = getProvider(evmNetwork);
	
	const ethWallet = ethers.Wallet.fromMnemonic(mnemonic);
	console.error(`====== my ETH address on ${evmNetwork}: `, process.env.devnet ? await provider.getSigner().getAddress() : ethWallet.address);

	const gasPrice = (await provider.getGasPrice()).toNumber() / 1e9;
	console.log('gas price', gasPrice);
	process.exit();
}


start();
