"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');
const { getProvider } = require("./evm/provider.js");
const { getAddressBlocks } = require("./etherscan.js");

const etherscan_base_url = process.env.testnet ? 'https://api-rinkeby.etherscan.io/' : 'https://api.etherscan.io';

let bCreated = false;

class Ethereum extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("Ethereum class already created, must be a singleton");
		bCreated = true;
		
	//	const provider = new ethers.providers.JsonRpcProvider("http://0.0.0.0:8545"); // default
		/*
		const provider = process.env.devnet
			? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
			: new ethers.providers.WebSocketProvider(process.env.testnet ? `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/eth/rinkeby/ws` : `https://speedy-nodes-nyc.moralis.io/${conf.moralis_key}/eth/mainnet/ws`);
		*/
		//	: ethers.providers.InfuraProvider.getWebSocketProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id);
		const provider = getProvider('Ethereum');
		super('Ethereum', conf.ethereum_factory_contract_addresses, conf.ethereum_assistant_factory_contract_addresses, provider);

	}

	forget() {
		console.log(`removing ${this.getProvider().listenerCount()} listeners on ${this.network}`);
		this.getProvider().removeAllListeners();
		bCreated = false;
	}

	getNativeSymbol() {
		return 'ETH';
	}

	getMaxBlockRange() {
		return 500;
	}

	async getAddressBlocks(address, startblock, startts) {
		return await getAddressBlocks({ base_url: etherscan_base_url, address, startblock, startts, api_key: conf.etherscan_api_key });
	}

}

module.exports = Ethereum;
