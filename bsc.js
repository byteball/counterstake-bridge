"use strict";
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://api-testnet.bscscan.com' : 'https://api.etherscan.io/v2';

let bCreated = false;

class BSC extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("BSC class already created, must be a singleton");
		bCreated = true;
		
		const provider = getProvider('BSC');
		super('BSC', conf.bsc_factory_contract_addresses, conf.bsc_assistant_factory_contract_addresses, provider);
	}

	forget() {
		console.log(`removing ${this.getProvider().listenerCount()} listeners on ${this.network}`);
		this.getProvider().removeAllListeners();
		bCreated = false;
	}

	getNativeSymbol() {
		return 'BNB';
	}

	getMaxBlockRange() {
		return 500;
	}

	getStaticGasPrice() {
		return process.env.testnet ? 5 : 3; // in gwei
	}

	async getAddressBlocks(address, startblock, startts) {
		return await getAddressBlocks({ base_url: etherscan_base_url, chainid: 56, address, startblock, startts, api_key: conf.etherscan_api_key });
	}

}

module.exports = BSC;
