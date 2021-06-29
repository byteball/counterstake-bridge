const fs = require("fs");
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const desktopApp = require("ocore/desktop_app.js");

const evmNetwork = 'Ethereum';
//const evmNetwork = 'BSC';

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});

async function start() {

	const mnemonic = JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase;

	const provider = process.env.devnet
		? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
		: (evmNetwork === 'Ethereum'
			? new ethers.providers.InfuraProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id)
			: new ethers.providers.JsonRpcProvider(process.env.testnet ? "https://data-seed-prebsc-1-s1.binance.org:8545" : "https://bsc-dataseed.binance.org"));
	
	const ethWallet = ethers.Wallet.fromMnemonic(mnemonic);
	console.error(`====== my ETH address on ${evmNetwork}: `, process.env.devnet ? await provider.getSigner().getAddress() : ethWallet.address);

	const gasPrice = (await provider.getGasPrice()).toNumber() / 1e9;
	console.log('gas price', gasPrice);
	process.exit();
}


start();
