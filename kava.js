"use strict";
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://testnet.explorer.kavalabs.io' : 'https://explorer.kavalabs.io';

let bCreated = false;

class Kava extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("Kava class already created, must be a singleton");
		bCreated = true;
		
		const provider = getProvider('Kava');
		super('Kava', conf.kava_factory_contract_addresses, conf.kava_assistant_factory_contract_addresses, provider);
	}

	forget() {
		console.log(`removing ${this.getProvider().listenerCount()} listeners on ${this.network}`);
		this.getProvider().removeAllListeners();
		bCreated = false;
	}

	getNativeSymbol() {
		return 'KAVA';
	}

	getMaxBlockRange() {
		return 10000;
	}

	getStaticGasPrice() {
		return 1; // in gwei
	}

	async getAddressBlocks(address, startblock, startts) {
		return await getAddressBlocks({ base_url: etherscan_base_url, address, startblock, startts });
	}

}

module.exports = Kava;
