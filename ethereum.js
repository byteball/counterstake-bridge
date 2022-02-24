"use strict";
const { ethers } = require("ethers");
const conf = require('ocore/conf.js');
const EvmChain = require('./evm-chain.js');

let bCreated = false;

class Ethereum extends EvmChain {

	constructor() {
		if (bCreated)
			throw Error("Ethereum class already created, must be a singleton");
		bCreated = true;
		
	//	const provider = new ethers.providers.JsonRpcProvider("http://0.0.0.0:8545"); // default
		const provider = process.env.devnet
			? new ethers.providers.JsonRpcProvider("http://0.0.0.0:7545") // ganache
			: ethers.providers.InfuraProvider.getWebSocketProvider(process.env.testnet ? "rinkeby" : "homestead", conf.infura_project_id);
		super('Ethereum', conf.ethereum_factory_contract_address, conf.ethereum_assistant_factory_contract_address, provider);

	}

	forget() {
		console.log(`removing ${this.getProvider().listenerCount()} listeners on ${this.network}`);
		this.getProvider().removeAllListeners();
		bCreated = false;
	}

	getNativeSymbol() {
		return 'ETH';
	}


}

module.exports = Ethereum;
