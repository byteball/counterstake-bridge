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
const { wait } = require('./utils.js');

const exportJson = require('./evm/build/contracts/Export.json');
const importJson = require('./evm/build/contracts/Import.json');
const erc20Json = require('./evm/build/contracts/ERC20.json');
const factoryJson = require('./evm/build/contracts/CounterstakeFactory.json');

const exportAssistantJson = require('./evm/build/contracts/ExportAssistant.json');
const importAssistantJson = require('./evm/build/contracts/ImportAssistant.json');
const assistantFactoryJson = require('./evm/build/contracts/AssistantFactory.json');

const { BigNumber, constants: { AddressZero } } = ethers;
const TIMEOUT_BETWEEN_TRANSACTIONS = 3000;


class EvmChain {
	network = "AbstractEVMChain";
	#factory_contract_address;
	#assistant_factory_contract_address;
	#provider;
	#wallet;
	#contractsByAddress = {};
	#bCatchingUp = true;
	#last_tx_ts = 0;
	#bWaitForMined = false; // set to true for unreliable providers that might lose a transaction

	getProvider() {
		return this.#provider;
	}

	getMaxBlockRange() {
		return 0;
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

	async getSinceBlock() {
		const last_block = Math.max(await this.getLastBlock() - 100, 0);
		if (!this.getMaxBlockRange())
			return last_block;
		console.log(`have max block range ${this.getMaxBlockRange()} on ${this.network}`);
		const currentBlockNumber = await this.#provider.getBlockNumber();
		const top_available_block = currentBlockNumber - this.getMaxBlockRange() + 100;
		if (last_block > top_available_block)
			return last_block;
		notifications.notifyAdmin(`missed ${top_available_block - last_block} blocks`, `${this.network} last block ${last_block}, top available block ${top_available_block}`);
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

	async getBlockTimestamp(blockHash) {
		const block = await this.#provider.getBlock(blockHash);
		if (!block)
			throw Error(`block ${blockHash} not found`);
		return block.timestamp;
	}

	async getLastStableTimestamp() {
		const currentBlockNumber = await this.#provider.getBlockNumber();
		const block = await this.#provider.getBlock(Math.max(currentBlockNumber - conf.evm_count_blocks_for_finality, 0))
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
		if (this.#cached_gas_price && this.#last_gas_price_ts > Date.now() - 1 * 60 * 1000)
			return this.#cached_gas_price;
		console.log('provider getGasPrice', this.network)
		this.#cached_gas_price = (await this.#provider.getGasPrice()).toNumber() / 1e9;
		this.#last_gas_price_ts = Date.now();
		console.log(`${this.network} gas price ${this.#cached_gas_price} gwei`);
		return this.#cached_gas_price;
	}

	// returns floating number in display units of the claimed asset
	async getMinReward(type, claimed_asset, src_network, src_asset, bWithAssistant, bCached) {
		console.log('getMinReward', type, claimed_asset, src_network, src_asset, bWithAssistant);
		const gas = bWithAssistant ? conf.evm_required_gas_with_pooled_assistant : conf.evm_required_gas;
		const fee = gas * (await this.getGasPrice()) / 1e9; // in Ether, 1 gwei = 1e-9 ETH
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

	isValidData(data) {
		return true;
	}

	// both are strings
	dataMatches(sent_data, claimed_data) {
		return sent_data === claimed_data;
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

	async getMyStake(bridge_aa, claim_num, outcome) {
		const contract = this.#contractsByAddress[bridge_aa];
		const side = outcome === 'yes' ? 1 : 0;
		const my_stake = await contract.stakes(claim_num, side, this.#wallet.address);
		return my_stake;
	}

	async getRequiredStake(bridge_aa, amount) {
		const contract = this.#contractsByAddress[bridge_aa];
		return await contract.getRequiredStake(amount);
	}

	async getMinTxAge(bridge_aa) {
		const contract = this.#contractsByAddress[bridge_aa];
		if (!contract)
			throw Error(`no contract by bridge AA ${bridge_aa}`);
		const settings = await contract.settings();
		console.error('settings', settings)
		return settings.min_tx_age;
	}

	async sendClaim({ bridge_aa, amount, reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts }) {
		const unlock = await mutex.lock(this.network + 'Tx');
		console.log(`will send a claim to ${this.network}`, { bridge_aa, amount, reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts });
		await this.waitBetweenTransactions();
		
	//	console.log(`will approve the export contract to spend our ERC20 ${staked_asset} claimed ${claimed_asset}`);
	//	const approval_res = await this.approve(staked_asset, bridge_aa);
	//	console.log('approval', approval_res);
		
		const bThirdPartyClaiming = (dest_address && dest_address !== this.#wallet.address);
		const paid_amount = bThirdPartyClaiming ? amount.sub(reward) : BigNumber.from(0);
		const total = (claimed_asset === staked_asset) ? stake.add(paid_amount) : stake;
		const contract = this.#contractsByAddress[bridge_aa];
		if (!contract)
			throw Error(`no contract by bridge AA ${bridge_aa}`);
		try {
			const res = await contract.claim(txid, txts, amount, reward, stake, sender_address, dest_address, data, (staked_asset === AddressZero) ? { value: total } : { value: 0 });
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
			return null;
		}
	}

	async sendClaimFromPooledAssistant({ assistant_aa, amount, reward, sender_address, dest_address, data, txid, txts }) {
		const unlock = await mutex.lock(this.network + 'Tx');
		if (!dest_address)
			throw Error(`no dest address in assistant claim`);
	//	if (dest_address === this.#wallet.address)
	//		throw Error(`assistant claim for oneself`);
		await this.waitBetweenTransactions();
		const contract = this.#contractsByAddress[assistant_aa];
		try {
			const res = await contract.claim(txid, txts, amount, reward, sender_address, dest_address, data);
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
		const res = await contract['challenge(uint256,uint8,uint256)'](claim_num, side, counterstake, { value: (asset === AddressZero) ? counterstake : 0 });
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
		const res = await contract.challenge(claim_num, side, counterstake);
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
		const res = to_address
			? await contract['withdraw(uint256,address)'](claim_num, to_address)
			: await contract['withdraw(uint256)'](claim_num);
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
		if (asset === AddressZero)
			res = await this.#wallet.sendTransaction({ to: address, value: amount });
		else {
			const contract = new ethers.Contract(asset, erc20Json.abi, this.#wallet);
			res = await contract.transfer(address, amount);
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
		console.log('NewExpatriation event', sender_address, amount, reward, foreign_address, data, event);
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
		console.log('NewRepatriation event', sender_address, amount, reward, home_address, data, event);
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
		console.log('NewClaim event', claim_num, author_address, sender_address, recipient_address, txid, txts, amount, reward, stake, data, expiry_ts, event);
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
		console.log('NewChallenge event', claim_num, author_address, stake, outcome, current_outcome, yes_stake, no_stake, expiry_ts, challenging_target, event);
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
		console.log('FinishedClaim event', claim_num, outcome, event);
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
		const token = new ethers.Contract(tokenAddress, erc20Json.abi, this.#wallet);
		try {
			const allowance = await token.allowance(this.#wallet.address, spenderAddress);
			if (allowance.gt(0)) {
				console.log(`spender ${spenderAddress} already approved`);
				return "already approved";
			}
			const res = await token.approve(spenderAddress, BigNumber.from(2).pow(256).sub(1));
			if (this.#bWaitForMined)
				await res.wait();
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

	async waitUntilSynced() {
		// assuming always synced
	}

	async refresh() {
		return false;
	}

	async startWatchingSymbolUpdates() {
		// assuming symbols are never updated
	}

	async startWatchingFactories() {
		const onNewExport = async (contractAddress, tokenAddress, foreign_network, foreign_asset) => {
			const decimals = await this.getDecimals(tokenAddress);
			if (decimals === null)
				return console.log(`not adding new export contract ${contractAddress} as its token ${tokenAddress} didn't return decimals`);
			if (tokenAddress !== AddressZero && conf.bUseOwnFunds) {
				console.log(`will approve the export contract to spend our ERC20 ${tokenAddress}`);
				const approval_res = await this.approve(tokenAddress, contractAddress);
				if (!approval_res)
					return console.log(`failed to approve new export contract ${contractAddress} to spend our token ${tokenAddress}, will not add`);
			}
			const bAdded = await transfers.handleNewExportAA(contractAddress, this.network, tokenAddress, decimals, foreign_network, foreign_asset);
			if (bAdded)
				this.startWatchingExportAA(contractAddress);
		};
		const onNewImport = async (contractAddress, home_network, home_asset, symbol, stakeTokenAddress) => {
			const bAdded = await transfers.handleNewImportAA(contractAddress, home_network, home_asset, this.network, contractAddress, 18, stakeTokenAddress);
			if (bAdded)
				this.startWatchingImportAA(contractAddress);
		};
		const contract = new ethers.Contract(this.#factory_contract_address, factoryJson.abi, this.#provider);
		contract.on('NewExport', onNewExport);
		contract.on('NewImport', onNewImport);

		const since_block = await this.getSinceBlock();
		await processPastEvents(contract, contract.filters.NewExport(), since_block, null, onNewExport);
		await processPastEvents(contract, contract.filters.NewImport(), since_block, null, onNewImport);
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
		const onNewExportAssistant = async (assistantAddress, bridgeAddress, manager, symbol) => {
		//	if (manager !== this.#wallet.address)
		//		return console.log(`new assistant ${assistantAddress} with another manager, will skip`);
			console.log(`new export assistant ${assistantAddress}, shares ${symbol}`);
			const bAdded = await transfers.handleNewAssistantAA('export', assistantAddress, bridgeAddress, this.network, manager, assistantAddress, symbol);
			if (bAdded)
				this.startWatchingExportAssistantAA(assistantAddress);
		};
		const onNewImportAssistant = async (assistantAddress, bridgeAddress, manager, symbol) => {
		//	if (manager !== this.#wallet.address)
		//		return console.log(`new assistant ${assistantAddress} with another manager, will skip`);
			console.log(`new import assistant ${assistantAddress}, shares ${symbol}`);
			const bAdded = await transfers.handleNewAssistantAA('import', assistantAddress, bridgeAddress, this.network, manager, assistantAddress, symbol);
			if (bAdded)
				this.startWatchingImportAssistantAA(assistantAddress);
		};
		const contract = new ethers.Contract(this.#assistant_factory_contract_address, assistantFactoryJson.abi, this.#provider);
		contract.on('NewExportAssistant', onNewExportAssistant);
		contract.on('NewImportAssistant', onNewImportAssistant);

		const since_block = await this.getSinceBlock();
		await processPastEvents(contract, contract.filters.NewExportAssistant(), since_block, null, onNewExportAssistant);
		await processPastEvents(contract, contract.filters.NewImportAssistant(), since_block, null, onNewImportAssistant);
	}


	// called on start-up to handle missed transfers
	async catchup() {
		const since_block = await this.getSinceBlock();
		for (let address in this.#contractsByAddress) {
			const contract = this.#contractsByAddress[address];
			if (!contract.filters.NewClaim) // not a bridge, must be an assistant
				continue;
			if (contract.filters.NewExpatriation)
				await processPastEvents(contract, contract.filters.NewExpatriation(), since_block, this, this.onNewExpatriation);
			if (contract.filters.NewRepatriation)
				await processPastEvents(contract, contract.filters.NewRepatriation(), since_block, this, this.onNewRepatriation);
			await processPastEvents(contract, contract.filters.NewClaim(), since_block, this, this.onNewClaim);
			await processPastEvents(contract, contract.filters.NewChallenge(), since_block, this, this.onNewChallenge);
			await processPastEvents(contract, contract.filters.FinishedClaim(), since_block, this, this.onFinishedClaim);
		}
		const unlock = await mutex.lock(this.network + 'Event'); // take the last place in the queue after all real events
		unlock();
		console.log(`catching up ${this.network} done`);
		this.#bCatchingUp = false;
		await this.updateLastBlock(await this.#provider.getBlockNumber());
	}

	constructor(network, factory_contract_address, assistant_factory_contract_address, provider, bWebsocket){
		this.network = network;
		this.#factory_contract_address = factory_contract_address;
		this.#assistant_factory_contract_address = assistant_factory_contract_address;
		this.#provider = provider;
		let wallet = ethers.Wallet.fromMnemonic(JSON.parse(fs.readFileSync(desktopApp.getAppDataDir() + '/keys.json')).mnemonic_phrase);
		console.log(`====== my ${network} address: `, wallet.address);
		this.#wallet = wallet.connect(provider);

		if (bWebsocket && !process.env.devnet) {
			provider.on('block', () => {
				console.log('new block', this.network);
				provider._websocket.ping();
			});
			provider._websocket.on('pong', () => console.log('pong', this.network));
			provider._websocket.on('close', () => {
				console.log('====== !!!!! websocket connection closed', this.network);
				this.forget();
				eventBus.emit('network_disconnected', this.network);
			});
		}
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

async function processPastEvents(contract, filter, since_block, thisArg, handler) {
	const events = await contract.queryFilter(filter, since_block);
	for (let event of events) {
		console.log('--- past event', event);
		let args = event.args.concat();
		args.push(event);
		await handler.apply(thisArg, args);
	}
}

module.exports = EvmChain;
