"use strict";
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://api-testnet.bscscan.com' : 'https://api.bscscan.com';

let bCreated = false;

class BSC extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("BSC class already created, must be a singleton");
		bCreated = true;
		
		const provider = getProvider('BSC');
		super('BSC', conf.bsc_factory_contract_address, conf.bsc_assistant_factory_contract_address, provider);
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
		return 1000;
	}

	async getAddressBlocks(address, startblock, startts) {
		return await getAddressBlocks({ base_url: etherscan_base_url, address, startblock, startts });
	}

}

module.exports = BSC;
