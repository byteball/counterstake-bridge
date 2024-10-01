"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const db = require('ocore/db.js');
const mutex = require('ocore/mutex.js');
const desktopApp = require("ocore/desktop_app.js");
const notifications = require('./notifications.js');
const transfers = require('./transfers.js');
const { fetchExchangeRateInNativeAsset } = require('./prices.js');
const { wait, watchForDeadlock, getVersion, asyncCallWithTimeout } = require('./utils.js');

const exportJson = require('./evm/build/contracts/Export.json');
const importJson = require('./evm/build/contracts/Import.json');
const erc20Json = require('./evm/build/contracts/ERC20.json');
const factoryJson = require('./evm/build/contracts/CounterstakeFactory.json');

const exportAssistantJson = require('./evm/build/contracts/ExportAssistant.json');
const importAssistantJson = require('./evm/build/contracts/ImportAssistant.json');
const assistantFactoryJson = require('./evm/build/contracts/AssistantFactory.json');

const { BigNumber, constants: { AddressZero } } = ethers;
const TIMEOUT_BETWEEN_TRANSACTIONS = 3000;

let cachedMinTxAges = {};


class EvmChain {
	network = "AbstractEVMChain";
	#factory_contract_addresses;
	#assistant_factory_contract_addresses;
	#provider;
	#wallet;
	#contractsByAddress = {};
	#bCatchingUp = true;
	#last_tx_ts = 0;
	#bWaitForMined = false; // set to true for unreliable providers that might lose a transaction
	#approved = {};

	getProvider() {
		return this.#provider;
	}

	getMaxBlockRange() {
		return 0;
	}

	getStaticGasPrice() {
		return 0; // in gwei
	}

	getGasPriceMultiplier() {
		return 0;
	}

	async getAddressBlocks(address, startblock, startts) {
		throw Error(`getAddressBlocks() unimplemented on ${this.network}`);
	}

	async waitBetweenTransactions() {
		while (this.#last_tx_ts > Date.now() - TIMEOUT_BETWEEN_TRANSACTIONS) {
			console.log(`will wait after the previous tx`);
			await wait(this.#last_tx_ts + TIMEOUT_BETWEEN_TRANSACTIONS - Date.now());
		}
	}

	async updateLastBlock(last_block) {
		if (!this.#bCatchingUp) // we handle events out of order while catching up
			await db.query("UPDATE last_blocks SET last_block=? WHERE network=?", [last_block, this.network]);
	}

	async getLastBlock() {
		const [{ last_block }] = await db.query("SELECT last_block FROM last_blocks WHERE network=?", [this.network]);
		return last_block;
	}

	async getTopAvailableBlock() {
		if (!this.getMaxBlockRange())
			return 0;
		const currentBlockNumber = await this.#provider.getBlockNumber();
		const top_available_block = currentBlockNumber - this.getMaxBlockRange() + 100;
		return top_available_block;
	}

	async getSinceBlock() {
		const last_block = Math.max(await this.getLastBlock() - 100, 0);
		if (!this.getMaxBlockRange())
			return last_block;
		console.log(`have max block range ${this.getMaxBlockRange()} on ${this.network}`);
		const top_available_block = await this.getTopAvailableBlock();
		if (last_block > top_available_block)
			return last_block;
		console.log(`getSinceBlock() missed ${top_available_block - last_block} blocks`, `${this.network} last block ${last_block}, top available block ${top_available_block}`);
		return top_available_block;
	}

	async getMyBalance(asset) {
		if (asset === AddressZero)
			return await this.#wallet.getBalance();
		const token = new ethers.Contract(asset, erc20Json.abi, this.#provider);
		return await token.balanceOf(this.#wallet.address);
	}

	async getBalance(address, asset) {
		if (asset === AddressZero)
			return await this.#provider.getBalance(address);
		const token = new ethers.Contract(asset, erc20Json.abi, this.#provider);
		return await token.balanceOf(address);
	}
	
	async getTransaction(txid) {
		return await this.#provider.getTransaction(txid);
	}

	async getBlockTimestamp(blockHash, bRetrying) {
		const block = await this.#provider.getBlock(blockHash);
		if (!block) {
			if (bRetrying)
				throw Error(`block ${blockHash} in ${this.network} not found`);
			console.log(`block ${blockHash} in ${this.network} not found, will retry`);
			await wait(15000);
			return await this.getBlockTimestamp(blockHash, true);
		}
		return block.timestamp;
	}

	async getLastStableTimestamp() {
		const currentBlockNumber = await this.#provider.getBlockNumber();
		if (!currentBlockNumber)
			throw Error(`no current block number in ${this.network}`);
		const last_finalized_block_number = Math.max(currentBlockNumber - conf.evm_count_blocks_for_finality, 0);
		const block = await this.#provider.getBlock(last_finalized_block_number);
		if (!block)
			throw Error(`failed to get block ${last_finalized_block_number}`);
		return block.timestamp;
	}

	getMinTransferAge() {
		return conf.evm_min_transfer_age;
	}

	#cached_gas_price;
	#last_gas_price_ts;

	// returns gas price in gwei as a js number
	async getGasPrice() {
		console.log('getGasPrice', this.network)
		if (this.getStaticGasPrice()) {
			console.log(`${this.network} has static gas price ${this.getStaticGasPrice()} gwei`);
			return this.getStaticGasPrice();
		}
		if (this.#cached_gas_price && this.#last_gas_price_ts > Date.now() - 1 * 60 * 1000)
			return this.#cached_gas_price;
		console.log('provider getGasPrice', this.network)
		try {
			this.#cached_gas_price = (await asyncCallWithTimeout(this.#provider.getGasPrice(), 10 * 1000)).toNumber() / 1e9;
			if (this.getGasPriceMultiplier())
				this.#cached_gas_price *= this.getGasPriceMultiplier();
		}
		catch (e) {
			if (!this.#cached_gas_price)
				throw e;
			console.log('provider getGasPrice', this.network, 'failed', e, 'using old cached value', this.#cached_gas_price);
			this.#last_gas_price_ts = Date.now();
			return this.#cached_gas_price;
		}
		this.#last_gas_price_ts = Date.now();
		console.log(`${this.network} gas price ${this.#cached_gas_price} gwei`);
		return this.#cached_gas_price;
	}

	// returns floating number in display units of the claimed asset
	async getMinReward(type, claimed_asset, src_network, src_asset, bWithAssistant, bCached) {
		console.log('getMinReward', type, claimed_asset, src_network, src_asset, bWithAssistant);
		const gas = bWithAssistant ? conf.evm_required_gas_with_pooled_assistant : conf.evm_required_gas;
		const fee = gas * (await this.getGasPrice()) / 1e9; // in Ether, 1 gwei = 1e-9 ETH
		console.log(`required gas for claim+withdraw (${bWithAssistant ? 'pooled' : 'solo'}): ${fee} ${this.getNativeSymbol()}`);
		if (claimed_asset === AddressZero)
			return fee;
		const rate = await fetchExchangeRateInNativeAsset(type, this.network, claimed_asset, src_network, src_asset, bCached);
		if (!rate)
			return null;
		return fee / rate;
	}

	getMyAddress() {
		return this.#wallet.address;
	}

	isMyAddress(address) {
		return address === this.#wallet.address;
	}

	// only mixed case hex addresses are allowed (ICAP addresses not allowed)
	isValidAddress(address) {
		try {
			return address.length === 42 && address === ethers.utils.getAddress(address);
		}
		catch (e) {
			return false;
		}
	}

	isValidTxid(txid) {
		return !!txid.match(/^0x[0-9a-f]{64}$/);
	}

	isValidNonnativeAsset(asset) {
		return asset !== AddressZero && this.isValidAddress(asset);
	}

	isValidAsset(asset) {
		return asset === AddressZero || this.isValidNonnativeAsset(asset);
	}

	isValidData(data) {
		return true;
	}

	// both are strings
	dataMatches(sent_data, claimed_data) {
		return sent_data === claimed_data;
	}

	async isContract(address) {
		try {
			const code = await this.#provider.getCode(address);
			return code !== '0x';
		}
		catch (e) {
			return false;
		}
	}

	async getClaim(bridge_aa, claim_num, bFinished, bThrowIfNotFound) {
		const contract = this.#contractsByAddress[bridge_aa];
		let claim = await contract['getClaim(uint256)'](claim_num);
		if (!claim || !claim.amount) {
			if (bThrowIfNotFound)
				throw Error(`claim ${claim_num} not found in ${this.network}, bFinished=${bFinished}`);
			return null;
		}
		claim = Object.assign({}, claim);
		claim.current_outcome = claim.current_outcome ? 'yes' : 'no';
		claim.stakes = { yes: claim.yes_stake, no: claim.no_stake };

		// challenging_target was removed to save gas, recalculate it
		const winning_stake = claim.current_outcome === 'yes' ? claim.yes_stake : claim.no_stake;
		const settings = await contract.settings();
		claim.challenging_target = winning_stake.mul(settings.counterstake_coef100).div(100);

		return claim;
	}

	async getMyStake(bridge_aa, claim_num, outcome, assistant_aa) {
		const contract = this.#contractsByAddress[bridge_aa];
		const side = outcome === 'yes' ? 1 : 0;
		const my_stake = await contract.stakes(claim_num, side, assistant_aa || this.#wallet.address);
		return my_stake;
	}

	async getRequiredStake(bridge_aa, amount) {
		const contract = this.#contractsByAddress[bridge_aa];
		if (!contract)
			throw Error(`no contract for bridge ${bridge_aa} on ${this.network}`);
		return await contract.getRequiredStake(amount);
	}

	async getMinTxAge(bridge_aa, attempt = 0) {
		const contract = this.#contractsByAddress[bridge_aa];
		if (!contract)
			throw Error(`no contract by bridge AA ${bridge_aa}`);
		try {
			const settings = await asyncCallWithTimeout(contract.settings(), 120 * 1000);
			console.log('settings', this.network, bridge_aa, settings)
			cachedMinTxAges[this.network][bridge_aa] = settings.min_tx_age;
			return settings.min_tx_age;
		}
		catch (e) {
			console.log(`error in getMinTxAge attempt=${attempt}`, this.network, bridge_aa, e);
			if (cachedMinTxAges[this.network][bridge_aa]) {
				console.log(`using cached value for min tx age`);
				return cachedMinTxAges[this.network][bridge_aa];
			}
			if (attempt < 5) {
				console.log(`will retry getMinTxAge in 30s`);
				await wait(30_000);
				return this.getMinTxAge(bridge_aa, attempt + 1);
			}
			throw Error(`getMinTxAge ${this.network} ${bridge_aa} failed: ${e.toString()}`);
		}
	}

	async addAccessListIfNecessary(opts, claimed_asset, staked_asset, dest_address) {
		if (claimed_asset === staked_asset && staked_asset === AddressZero && await this.isContract(dest_address)) {
			opts.accessList = [{ address: dest_address, storageKeys: [] }];
			const code = await this.#provider.getCode(dest_address);
			try {
				const masterAddress = ethers.utils.getAddress('0x' + code.slice(22, 62));
				if (await this.isContract(masterAddress))
					opts.accessList.push({ address: masterAddress, storageKeys: [] });
			}
			catch(e){}
			console.log('using accessList', opts.accessList);
		}
	}

	async sendClaim({ bridge_aa, amount, reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts }) {
		const unlock = await mutex.lock(this.network + 'Tx');
		console.log(`will send a claim to ${this.network}`, { bridge_aa, amount, reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts });
		await this.waitBetweenTransactions();
		
		if (staked_asset !== AddressZero) {
			const approval_res = await this.approve(staked_asset, bridge_aa);
			if (!approval_res)
				throw Error(`failed to approve ${bridge_aa} to spend our ${staked_asset}`);
		}

		const bThirdPartyClaiming = (dest_address && dest_address !== this.#wallet.address);
		const paid_amount = bThirdPartyClaiming ? amount.sub(reward) : BigNumber.from(0);
		const total = (claimed_asset === staked_asset) ? stake.add(paid_amount) : stake;
		const contract = this.#contractsByAddress[bridge_aa];
		if (!contract)
			throw Error(`no contract by bridge AA ${bridge_aa}`);
		try {
			let opts = (staked_asset === AddressZero) ? { value: total } : { value: 0 };
			if (this.getGasPriceMultiplier())
				opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
			await this.addAccessListIfNecessary(opts, claimed_asset, staked_asset, dest_address);
			const res = await contract.claim(txid, txts, amount, reward, stake, sender_address, dest_address, data, opts);
			const claim_txid = res.hash;
			console.log(`sent claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}: ${claim_txid}`);
			this.#last_tx_ts = Date.now();
			if (this.#bWaitForMined)
				await res.wait();
		//	const receipt = await res.wait();
		//	console.log('tx mined, receipt', receipt, 'events', receipt.events, 'args', receipt.events[1].args);
			unlock();
			return claim_txid;
		}
		catch (e) {
			console.log(`failed to send claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}`, e);
			unlock();
			if (e.toString().includes('has already been claimed')) {
				console.log(`transfer ${txid} already claimed, maybe we missed the event?`);
				process.nextTick(async () => {
					console.log(`will rescan events since ${txts}`);
					const blocks = await this.getAddressBlocks(bridge_aa, 0, txts);
					console.log(`blocks since ${txts}:`, blocks);
					for (let blockNumber of blocks) {
						await this.processPastEventsOnBridgeContract(contract, blockNumber, blockNumber);
					}
				});
			}
			return null;
		}
	}

	async sendClaimFromPooledAssistant({ assistant_aa, amount, reward, claimed_asset, staked_asset, sender_address, dest_address, data, txid, txts }) {
		const unlock = await mutex.lock(this.network + 'Tx');
		if (!dest_address)
			throw Error(`no dest address in assistant claim`);
	//	if (dest_address === this.#wallet.address)
	//		throw Error(`assistant claim for oneself`);
		await this.waitBetweenTransactions();
		const contract = this.#contractsByAddress[assistant_aa];
		try {
			let opts = {};
			if (this.getGasPriceMultiplier())
				opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
			await this.addAccessListIfNecessary(opts, claimed_asset, staked_asset, dest_address);
			const res = await contract.claim(txid, txts, amount, reward, sender_address, dest_address, data, opts);
			const claim_txid = res.hash;
			console.log(`sent assistant claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}: ${claim_txid}`);
			this.#last_tx_ts = Date.now();
			if (this.#bWaitForMined)
				await res.wait();
			unlock();
			return claim_txid;
		}
		catch (e) {
			console.log(`failed to send assistant claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}`, e);
			unlock();
			return null;
		}
	}

	async sendChallenge(bridge_aa, claim_num, stake_on, asset, counterstake) {
		const unlock = await mutex.lock(this.network + 'Tx');
		await this.waitBetweenTransactions();
		const side = stake_on === 'yes' ? 1 : 0;
		const contract = this.#contractsByAddress[bridge_aa];
		let opts = { value: (asset === AddressZero) ? counterstake : 0 };
		if (this.getGasPriceMultiplier())
			opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
		const res = await contract['challenge(uint256,uint8,uint256)'](claim_num, side, counterstake, opts);
		const txid = res.hash;
		console.log(`sent counterstake ${counterstake} for "${stake_on}" to challenge claim ${claim_num}: ${txid}`);
		this.#last_tx_ts = Date.now();
		if (this.#bWaitForMined)
			await res.wait();
		unlock();
		return txid;
	}

	async sendChallengeFromPooledAssistant(assistant_aa, claim_num, stake_on, counterstake) {
		const unlock = await mutex.lock(this.network + 'Tx');
		await this.waitBetweenTransactions();
		const side = stake_on === 'yes' ? 1 : 0;
		const contract = this.#contractsByAddress[assistant_aa];
		let opts = {};
		if (this.getGasPriceMultiplier())
			opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
		const res = await contract.challenge(claim_num, side, counterstake, opts);
		const txid = res.hash;
		console.log(`sent assistant counterstake ${counterstake} for "${stake_on}" to challenge claim ${claim_num}: ${txid}`);
		this.#last_tx_ts = Date.now();
		if (this.#bWaitForMined)
			await res.wait();
		unlock();
		return txid;
	}

	async sendWithdrawalRequest(bridge_aa, claim_num, to_address) {
		const unlock = await mutex.lock(this.network + 'Tx');
		await this.waitBetweenTransactions();
		const contract = this.#contractsByAddress[bridge_aa];
		let opts = {};
		if (to_address) { // it must be an assistant contract
			const code = await this.#provider.getCode(to_address);
			const masterAddress = ethers.utils.getAddress('0x' + code.slice(22, 62));
			opts.accessList = [
				{ address: masterAddress, storageKeys: [] },
				{ address: to_address, storageKeys: ["0x0000000000000000000000000000000000000000000000000000000000000007"] },
			];
			opts.gasLimit = 300000;
		}
		if (this.getGasPriceMultiplier())
			opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
		const res = to_address
			? await contract['withdraw(uint256,address)'](claim_num, to_address, opts)
			: await contract['withdraw(uint256)'](claim_num, opts);
		const txid = res.hash;
		console.log(`sent withdrawal request on claim ${claim_num} to ${to_address || 'self'}: ${txid}`);
		this.#last_tx_ts = Date.now();
		if (this.#bWaitForMined)
			await res.wait();
		unlock();
		return txid;
	}

	async sendPayment(asset, address, amount, recipient_device_address) {
		let res;
		if (asset === AddressZero) {
			let opts = { to: address, value: amount };
			if (this.getGasPriceMultiplier())
				opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
			res = await this.#wallet.sendTransaction(opts);
		}
		else {
			const contract = new ethers.Contract(asset, erc20Json.abi, this.#wallet);
			let opts = {};
			if (this.getGasPriceMultiplier())
				opts.gasPrice = Math.round(1e9 * (await this.getGasPrice()));
			res = await contract.transfer(address, amount, opts);
		}
		const txid = res.hash;
		console.log(`sent payment ${amount} ${asset} to ${address}: ${txid}`);
		if (this.#bWaitForMined)
			await res.wait();
		return txid;
	}


	startWatchingExportAA(export_aa) {
		const contract = new ethers.Contract(export_aa, exportJson.abi, this.#wallet);
		contract.on('NewExpatriation', this.onNewExpatriation.bind(this));
		this.addCounterstakeEventHandlers(contract);
		this.#contractsByAddress[export_aa] = contract;
	}

	startWatchingImportAA(import_aa) {
		const contract = new ethers.Contract(import_aa, importJson.abi, this.#wallet);
		contract.on('NewRepatriation', this.onNewRepatriation.bind(this));
		this.addCounterstakeEventHandlers(contract);
		this.#contractsByAddress[import_aa] = contract;
	}


	addCounterstakeEventHandlers(contract) {
		contract.on('NewClaim', this.onNewClaim.bind(this));
		contract.on('NewChallenge', this.onNewChallenge.bind(this));
		contract.on('FinishedClaim', this.onFinishedClaim.bind(this));
	}

	async onNewExpatriation(sender_address, amount, reward, foreign_address, data, event) {
		const unlock = await mutex.lock(this.network + 'Event');
		console.log('NewExpatriation event', this.network, sender_address, amount.toString(), reward.toString(), foreign_address, data, event);
		const txid = event.transactionHash;
		const txts = await this.getBlockTimestamp(event.blockHash);
		const bridge = await transfers.getBridgeByAddress(event.address, true);
		const { bridge_id, export_aa } = bridge;
		if (export_aa !== event.address)
			throw Error(`expatriation on non-export address? export_aa=${export_aa}, address=${event.address}`);
		const transfer = { bridge_id, type: 'expatriation', amount, reward, sender_address, dest_address: foreign_address, data, txid, txts };
		console.log('transfer', transfer);
		event.removed ? await transfers.removeTransfer(transfer) : await transfers.addTransfer(transfer, true);
		await this.updateLastBlock(event.blockNumber);
		unlock();
	}

	async onNewRepatriation(sender_address, amount, reward, home_address, data, event) {
		const unlock = await mutex.lock(this.network + 'Event');
		console.log('NewRepatriation event', this.network, sender_address, amount.toString(), reward.toString(), home_address, data, event);
		const txid = event.transactionHash;
		const txts = await this.getBlockTimestamp(event.blockHash);
		const bridge = await transfers.getBridgeByAddress(event.address, true);
		const { bridge_id, import_aa } = bridge;
		if (import_aa !== event.address)
			throw Error(`repatriation on non-export address? import_aa=${import_aa}, address=${event.address}`);
		const transfer = { bridge_id, type: 'repatriation', amount, reward, sender_address, dest_address: home_address, data, txid, txts };
		event.removed ? await transfers.removeTransfer(transfer) : await transfers.addTransfer(transfer, true);
		await this.updateLastBlock(event.blockNumber);
		unlock();
	}

	async onNewClaim(claim_num, author_address, sender_address, recipient_address, txid, txts, amount, reward, stake, data, expiry_ts, event) {
		const unlock = await mutex.lock(this.network + 'Event');
		claim_num = claim_num.toNumber();
		console.log('NewClaim event', this.network, claim_num, author_address, sender_address, recipient_address, txid, txts, amount.toString(), reward.toString(), stake.toString(), data, expiry_ts, event);
		if (event.removed)
			return unlock(`the claim event was removed, ignoring`);
		const bridge = await transfers.getBridgeByAddress(event.address, true);
		const type = getType(event.address, bridge);
		const dest_address = recipient_address;
		const claimant_address = author_address;
		await transfers.handleNewClaim(bridge, type, claim_num, sender_address, dest_address, claimant_address, data, amount, reward, stake, txid, txts, event.transactionHash);
		await this.updateLastBlock(event.blockNumber);
		unlock();
	}

	async onNewChallenge(claim_num, author_address, stake, outcome, current_outcome, yes_stake, no_stake, expiry_ts, challenging_target, event) {
		const unlock = await mutex.lock(this.network + 'Event');
		claim_num = claim_num.toNumber();
		console.log('NewChallenge event', this.network, claim_num, author_address, stake.toString(), outcome, current_outcome, yes_stake, no_stake, expiry_ts, challenging_target, event);
		if (event.removed)
			return unlock(`the challenge event was removed, ignoring`);
		const bridge = await transfers.getBridgeByAddress(event.address, true);
		const type = getType(event.address, bridge);
		await transfers.handleChallenge(bridge, type, claim_num, author_address, outcome ? 'yes' : 'no', stake, event.transactionHash);
		await this.updateLastBlock(event.blockNumber);
		unlock();
	}

	async onFinishedClaim(claim_num, outcome, event) {
		const unlock = await mutex.lock(this.network + 'Event');
		claim_num = claim_num.toNumber();
		console.log('FinishedClaim event', this.network, claim_num, outcome, event);
		if (event.removed)
			return unlock(`the finish event was removed, ignoring`);
		const bridge = await transfers.getBridgeByAddress(event.address, true);
		const type = getType(event.address, bridge);
		await transfers.handleWithdrawal(bridge, type, claim_num, event.transactionHash);
		await this.updateLastBlock(event.blockNumber);
		unlock();
	}


	async getDecimals(tokenAddress) {
		if (tokenAddress === AddressZero)
			return 18;
		const token = new ethers.Contract(tokenAddress, erc20Json.abi, this.#provider);
		try {
			return await token.decimals();
		}
		catch (e) {
			console.log(`getDecimals(${tokenAddress}) failed`, e);
			return null;
		}
	}

	async getSymbol(tokenAddress) {
		if (tokenAddress === AddressZero)
			return this.getNativeSymbol();
		const token = new ethers.Contract(tokenAddress, erc20Json.abi, this.#provider);
		try {
			return await token.symbol();
		}
		catch (e) {
			console.log(`getSymbol(${tokenAddress}) failed`, e);
			return null;
		}
	}

	async approve(tokenAddress, spenderAddress) {
		if (tokenAddress === AddressZero)
			throw Error(`don't need to approve ETH`);
		if (this.#approved[tokenAddress + '-' + spenderAddress])
			return "already approved";
		const token = new ethers.Contract(tokenAddress, erc20Json.abi, this.#wallet);
		try {
			const allowance = await token.allowance(this.#wallet.address, spenderAddress);
			if (allowance.gt(0)) {
				console.log(`spender ${spenderAddress} already approved`);
				this.#approved[tokenAddress + '-' + spenderAddress] = true;
				return "already approved";
			}
			console.log(`will approve spender ${spenderAddress} to spend our token ${tokenAddress}`);
			const res = await token.approve(spenderAddress, BigNumber.from(2).pow(256).sub(1));
			if (this.#bWaitForMined)
				await res.wait();
			this.#approved[tokenAddress + '-' + spenderAddress] = true;
			return res;
		}
		catch (e) {
			console.log(`approve(${spenderAddress}) failed`, e);
			return null;
		}
	}

	getNativeSymbol() {
		throw Error(`getNativeSymbol should be implemented in descendant classes`);
	}

	async waitForTransaction(txid) {
		const receipt = await this.#provider.waitForTransaction(txid);
		if (!receipt.status)
			console.log(`tx ${txid} reverted: `, receipt);
		return receipt.status;
	}

	async waitUntilSynced() {
		// assuming always synced
	}

	// returns true if the transfer event might have appeared after refreshing
	async refresh(txid) {
		console.log(`will refresh trying to find tx ${txid} in ${this.network}`);
		if (!this.isValidTxid(txid)) {
			console.log(`invalid tx format ${txid} in ${this.network}`);
			return false;
		}
		const tx = await this.getTransaction(txid);
		if (!tx) {
			console.log(`tx ${txid} not found in ${this.network}`);
			return false;
		}
		if (!tx.blockNumber) {
			console.log(`tx ${txid} found but not mined in ${this.network}`);
			return false;
		}
		const since_block = tx.blockNumber;
		let to_block = 0;
		const block_range = this.getMaxBlockRange();
		if (block_range) {
			const top_available_block = await this.getTopAvailableBlock();
			if (top_available_block > since_block - 100) {
				to_block = since_block + block_range;
				console.log(`tx ${txid} exists but is out of block range, will scan events until block ${to_block}`);
			}
		}
		// rescan transfers since that block in case we missed them
		console.log(`will rescan past events trying to find the transfer event in tx ${txid} in ${this.network}`);
		for (let address in this.#contractsByAddress) {
			const contract = this.#contractsByAddress[address];
			if (!contract.filters.NewClaim) // not a bridge, must be an assistant
				continue;
			if (contract.filters.NewExpatriation)
				await processPastEvents(contract, contract.filters.NewExpatriation(), since_block, to_block, this, this.onNewExpatriation);
			if (contract.filters.NewRepatriation)
				await processPastEvents(contract, contract.filters.NewRepatriation(), since_block, to_block, this, this.onNewRepatriation);
		}
		return true;
	}

	async startWatchingSymbolUpdates() {
		// assuming symbols are never updated
	}

	async startWatchingFactories() {
		const onNewExport = async (contractAddress, tokenAddress, foreign_network, foreign_asset, event) => {
			const decimals = await this.getDecimals(tokenAddress);
			if (decimals === null)
				return console.log(`not adding new export contract ${contractAddress} as its token ${tokenAddress} didn't return decimals`);
			/*if (tokenAddress !== AddressZero && conf.bUseOwnFunds) {
				console.log(`will approve the export contract to spend our ERC20 ${tokenAddress}`);
				const approval_res = await this.approve(tokenAddress, contractAddress);
				if (!approval_res)
					return console.log(`failed to approve new export contract ${contractAddress} to spend our token ${tokenAddress}, will not add`);
			}*/
			const version = getVersion(this.#factory_contract_addresses, event.address);
			if (!version)
				throw Error(`undefined version of new export ${contractAddress} ${JSON.stringify(event)}`);
			const bAdded = await transfers.handleNewExportAA(contractAddress, this.network, tokenAddress, decimals, foreign_network, foreign_asset, version);
			if (bAdded)
				this.startWatchingExportAA(contractAddress);
		};
		const onNewImport = async (contractAddress, home_network, home_asset, symbol, stakeTokenAddress, event) => {
			const version = getVersion(this.#factory_contract_addresses, event.address);
			if (!version)
				throw Error(`undefined version of new import ${contractAddress} ${JSON.stringify(event)}`);
			const bAdded = await transfers.handleNewImportAA(contractAddress, home_network, home_asset, this.network, contractAddress, 18, stakeTokenAddress, version);
			if (bAdded)
				this.startWatchingImportAA(contractAddress);
		};
		for (let v in this.#factory_contract_addresses) {
			const factory_contract_address = this.#factory_contract_addresses[v];
			const contract = new ethers.Contract(factory_contract_address, factoryJson.abi, this.#provider);
			contract.on('NewExport', onNewExport);
			contract.on('NewImport', onNewImport);

			const processPastEventsOnContract = async (from_block, to_block) => {
				console.log('factories processPastEventsOnContract', this.network, from_block, to_block);
				await processPastEvents(contract, contract.filters.NewExport(), from_block, to_block, null, onNewExport);
				await processPastEvents(contract, contract.filters.NewImport(), from_block, to_block, null, onNewImport);
			};
		
			// get factory events that are beyond the block range
			const last_block = Math.max(await this.getLastBlock() - 100, 0);
			const top_available_block = await this.getTopAvailableBlock();
			if (top_available_block > last_block) {
				console.log(this.network, 'factories top available block', top_available_block, '> last block', last_block);
				const blocks = await this.getAddressBlocks(factory_contract_address, last_block);
				console.log('factories blocks of missed txs', this.network, blocks);
				for (let blockNumber of blocks) {
					await processPastEventsOnContract(blockNumber, blockNumber);
				}
			}

			const since_block = await this.getSinceBlock();
			await processPastEventsOnContract(since_block, 0);
		}
	}

	
	// assistants

	startWatchingExportAssistantAA(export_assistant_aa) {
		const contract = new ethers.Contract(export_assistant_aa, exportAssistantJson.abi, this.#wallet);
		this.#contractsByAddress[export_assistant_aa] = contract;
	}

	startWatchingImportAssistantAA(import_assistant_aa) {
		const contract = new ethers.Contract(import_assistant_aa, importAssistantJson.abi, this.#wallet);
		this.#contractsByAddress[import_assistant_aa] = contract;
	}

	async startWatchingAssistantFactories() {
		const onNewExportAssistant = async (assistantAddress, bridgeAddress, manager, symbol, event) => {
		//	if (manager !== this.#wallet.address)
		//		return console.log(`new assistant ${assistantAddress} with another manager, will skip`);
			console.log(`new export assistant ${assistantAddress}, shares ${symbol}`);
			const version = getVersion(this.#assistant_factory_contract_addresses, event.address);
			if (!version)
				throw Error(`undefined version of new export assistant ${assistantAddress} ${JSON.stringify(event)}`);
			const bAdded = await transfers.handleNewAssistantAA('export', assistantAddress, bridgeAddress, this.network, manager, assistantAddress, symbol, version);
			if (bAdded)
				this.startWatchingExportAssistantAA(assistantAddress);
		};
		const onNewImportAssistant = async (assistantAddress, bridgeAddress, manager, symbol, event) => {
		//	if (manager !== this.#wallet.address)
		//		return console.log(`new assistant ${assistantAddress} with another manager, will skip`);
			console.log(`new import assistant ${assistantAddress}, shares ${symbol}`);
			const version = getVersion(this.#assistant_factory_contract_addresses, event.address);
			if (!version)
				throw Error(`undefined version of new import assistant ${assistantAddress} ${JSON.stringify(event)}`);
			const bAdded = await transfers.handleNewAssistantAA('import', assistantAddress, bridgeAddress, this.network, manager, assistantAddress, symbol, version);
			if (bAdded)
				this.startWatchingImportAssistantAA(assistantAddress);
		};
		for (let v in this.#assistant_factory_contract_addresses) {
			const assistant_factory_contract_address = this.#assistant_factory_contract_addresses[v];
			const contract = new ethers.Contract(assistant_factory_contract_address, assistantFactoryJson.abi, this.#provider);
			contract.on('NewExportAssistant', onNewExportAssistant);
			contract.on('NewImportAssistant', onNewImportAssistant);

			const processPastEventsOnContract = async (from_block, to_block) => {
				console.log('assistants processPastEventsOnContract', this.network, from_block, to_block);
				await processPastEvents(contract, contract.filters.NewExportAssistant(), from_block, to_block, null, onNewExportAssistant);
				await processPastEvents(contract, contract.filters.NewImportAssistant(), from_block, to_block, null, onNewImportAssistant);
			};

			// get factory events that are beyond the block range
			const last_block = Math.max(await this.getLastBlock() - 100, 0);
			const top_available_block = await this.getTopAvailableBlock();
			if (top_available_block > last_block) {
				console.log(this.network, 'assistants top available block', top_available_block, '> last block', last_block);
				const blocks = await this.getAddressBlocks(assistant_factory_contract_address, last_block);
				console.log('assistants blocks of missed txs', this.network, blocks);
				for (let blockNumber of blocks) {
					await processPastEventsOnContract(blockNumber, blockNumber);
				}
			}

			const since_block = await this.getSinceBlock();
			await processPastEventsOnContract(since_block, 0);
		}
	}


	async processPastEventsOnBridgeContract(contract, from_block, to_block) {
		console.log('processPastEventsOnBridgeContract', this.network, contract.address, from_block, to_block);
		let count = 0;
		if (contract.filters.NewExpatriation)
			count += await processPastEvents(contract, contract.filters.NewExpatriation(), from_block, to_block, this, this.onNewExpatriation);
		if (contract.filters.NewRepatriation)
			count += await processPastEvents(contract, contract.filters.NewRepatriation(), from_block, to_block, this, this.onNewRepatriation);
		count += await processPastEvents(contract, contract.filters.NewClaim(), from_block, to_block, this, this.onNewClaim);
		count += await processPastEvents(contract, contract.filters.NewChallenge(), from_block, to_block, this, this.onNewChallenge);
		count += await processPastEvents(contract, contract.filters.FinishedClaim(), from_block, to_block, this, this.onFinishedClaim);
		console.log('processPastEventsOnBridgeContract', this.network, contract.address, from_block, to_block, `found ${count} events`);
		return count;
	}

	// called on start-up to handle missed transfers
	async catchup() {
		console.log(`will catch up ${this.network}`);

		// get events that are beyond the block range
		const last_block = Math.max(await this.getLastBlock() - 100, 0);
		const top_available_block = await this.getTopAvailableBlock();
		if (top_available_block > last_block) {
			for (let address in this.#contractsByAddress) {
				const contract = this.#contractsByAddress[address];
				if (!contract.filters.NewClaim) // not a bridge, must be an assistant
					continue;
				const blocks = await this.getAddressBlocks(address, last_block);
				console.log(`${this.network} contract ${address} blocks of missed txs since ${last_block}`, blocks);
				for (let blockNumber of blocks) {
					const count = await this.processPastEventsOnBridgeContract(contract, blockNumber, blockNumber);
					if (!count)
						console.log(`no CS events on contract ${address}@${this.network} in block ${blockNumber}`);
				}
			}
		}

		const since_block = await this.getSinceBlock();
		for (let address in this.#contractsByAddress) {
			const contract = this.#contractsByAddress[address];
			if (!contract.filters.NewClaim) // not a bridge, must be an assistant
				continue;
			await this.processPastEventsOnBridgeContract(contract, since_block, 0);
		}
		const unlock = await mutex.lock(this.network + 'Event'); // take the last place in the queue after all real events
		unlock();
		console.log(`catching up ${this.network} done`);
		this.#bCatchingUp = false;
		await this.updateLastBlock(await this.#provider.getBlockNumber());
	}

	constructor(network, factory_contract_addresses, assistant_factory_contract_addresses, provider){
		this.network = network;
		this.#factory_contract_addresses = factory_contract_addresses;
		this.#assistant_factory_contract_addresses = assistant_factory_contract_addresses;
		this.#provider = provider;
		let wallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
		console.log(`====== my ${network} address: `, wallet.address);
		this.#wallet = wallet.connect(provider);
		if (!cachedMinTxAges[network])
			cachedMinTxAges[network] = {};

		if (provider._websocket && !process.env.devnet) {
			let closed = false;
			const forgetAndEmitDisconnected = () => {
				clearTimeout(scheduledReconnectTimeout);
				clearInterval(interval);
				closed = true;
				this.forget();
				provider._websocket.removeAllListeners();
				console.log(`will wait before emitting disconnection event on`, this.network);
				setTimeout(() => eventBus.emit('network_disconnected', this.network), 60 * 1000);
			};
			const closeSocket = () => {
				try {
					provider._websocket.close();
				}
				catch (e) {
					console.log(`ws close ${this.network} failed`, e);
				}
			};
			const pingSocket = () => {
				try {
					provider._websocket.ping();
				}
				catch (e) {
					console.log(`ping ${this.network} failed`, e);
				}
			};
			let last_pong_ts = Date.now();
			if (conf[network + '_noblocks']) {
				var interval = setInterval(() => {
					pingSocket();
					if (Date.now() - last_pong_ts > 5 * 60 * 1000) {
						console.log(`====== no new pongs on ${this.network} in more than 5 mins, will reset websocket connection`);
						forgetAndEmitDisconnected();
						closeSocket();
					}
				}, 60 * 1000);
			}
			else {
				let last_block_ts = Date.now();
				var interval = setInterval(() => {
					if (Date.now() - last_block_ts > 5 * 60 * 1000) {
						console.log(`====== no new blocks on ${this.network} in more than 5 mins, will reset websocket connection`);
						forgetAndEmitDisconnected();
						closeSocket();
					}
				}, 60 * 1000);
				provider.on('block', (blockNumber) => {
					console.log('new block', this.network, blockNumber);
					last_block_ts = Date.now();
					pingSocket();
				});
			}
			var scheduledReconnectTimeout = setTimeout(() => {
				console.log(`====== scheduled reconnect on ${this.network}`);
				forgetAndEmitDisconnected();
				closeSocket();
			}, 23 * 3600 * 1000);
			provider._websocket.on('pong', () => {
				last_pong_ts = Date.now();
				console.log('pong', this.network);
			});
			provider._websocket.on('ping', () => console.log('ping', this.network));
			provider._websocket.on('close', () => {
				console.log('====== !!!!! websocket connection closed', this.network);
				if (closed)
					return console.log('close event: ws already closed');
				forgetAndEmitDisconnected();
			});
			provider._websocket.on('error', (error) => {
				console.log('====== !!!!! websocket error', this.network, error);
				if (closed)
					return console.log('error event: ws already closed');
				closeSocket();
				forgetAndEmitDisconnected();
			});
			console.log(`${this.network} constructor done`);
		}

		watchForDeadlock(this.network + 'Event');
		watchForDeadlock(this.network + 'Tx');
		watchForDeadlock(this.network);
	}

}


function getType(address, bridge) {
	const { bridge_id, export_aa, import_aa } = bridge;
	if (export_aa && address === export_aa)
		return 'repatriation';
	if (import_aa && address === import_aa)
		return 'expatriation';
	throw Error(`unable to determine transfer type on address ${address} and bridge ${bridge_id}, export_aa=${export_aa}, import_aa=${import_aa}`);
}

async function processPastEvents(contract, filter, since_block, to_block, thisArg, handler) {
	const network = thisArg ? thisArg.network : null;
	console.log('processPastEvents', network, contract.address, since_block, to_block, filter);
	try {
		var events = await contract.queryFilter(filter, since_block, to_block || 'latest');
	}
	catch (e) {
		console.log(`processPastEvents failed`, network, contract.address, since_block, to_block, e);
		const errMsg = e.toString();
		if (errMsg.includes("rate-limit") || errMsg.includes("project ID request rate exceeded")) {
			console.log(`will retry later`);
			await wait(100);
			return processPastEvents(contract, filter, since_block, to_block, thisArg, handler);
		}
		throw e;
	}
	for (let event of events) {
		console.log('--- past event', network, event);
		let args = event.args.concat();
		args.push(event);
		await handler.apply(thisArg, args);
	}
	console.log('processPastEvents', network, contract.address, since_block, to_block, `found ${events.length} events`);
	return events.length;
}

module.exports = EvmChain;
