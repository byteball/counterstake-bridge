"use strict";
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const aa_composer = require('ocore/aa_composer.js');
const network = require('ocore/network.js');
const walletGeneral = require("ocore/wallet_general.js");
const mutex = require('ocore/mutex.js');
const string_utils = require("ocore/string_utils.js");
const db = require('ocore/db.js');
const balances = require('ocore/balances.js');
const validationUtils = require('ocore/validation_utils.js');

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const notifications = require('./notifications.js');
const transfers = require('./transfers.js');

let bCreated = false;

class Obyte {

	network = "Obyte";

	async getMyBalance(asset) {
		const my_balances = await operator.readBalances();
		return my_balances[asset] ? my_balances[asset].total : 0;
	}

	async getBalance(address, asset, bExternalAddress) {
		if (bExternalAddress) {
			const balances = await dag.readBalance(address);
			return balances[asset] ? balances[asset].total : 0;
		}
		return new Promise(resolve => balances.readOutputsBalance(address, assocBalances => resolve(assocBalances[asset] ? assocBalances[asset].total : 0)));
	}

	async getTransaction(txid) {
		return await dag.readJoint(txid);
	}

	async getLastStableTimestamp() {
		const { timestamp } = await dag.getLastStableUnitProps();
		return timestamp;
	}

	getMinTransferAge() {
		return conf.obyte_min_transfer_age; // after MCI timestamp, which is backdated when the AA trigger is processed
	}

	async getMinReward(type, claimed_asset, src_network, src_asset, bWithAssistant, bCached) {
		return 0;
	}

	getMyAddress() {
		return operator.getAddress();
	}

	isMyAddress(address) {
		return address === operator.getAddress();
	}

	isValidAddress(address) {
		return validationUtils.isValidAddress(address);
	}

	async getClaim(bridge_aa, claim_num, bFinished, bThrowIfNotFound) {
		const prefix = bFinished ? 'f_' : 'o_';
		const claim = await dag.readAAStateVar(bridge_aa, prefix + claim_num);
		if (!claim) {
			if (bThrowIfNotFound)
				throw Error(`${prefix} claim ${claim_num} not found in DAG`);
			return null;
		}
		return claim;
	}

	async getMyStake(bridge_aa, claim_num, outcome) {
		const my_stake = await dag.readAAStateVar(bridge_aa, claim_num + '_' + outcome + '_by_' + operator.getAddress());
		return my_stake || 0;
	}

	async getRequiredStake(bridge_aa, amount) {
		return await dag.executeGetter(bridge_aa, 'get_required_stake', [amount.toNumber()]);
	}

	async getMinTxAge(bridge_aa) {
		return await dag.executeGetter(bridge_aa, 'get_min_tx_age');
	}

	async sendClaim({ bridge_aa, amount, reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts }) {
		amount = amount.toNumber();
		reward = reward.toNumber();
		stake = stake.toNumber();
		const trigger_data = {
			sender_address,
			amount,
			reward,
			txid,
			txts,
		};
		if (data)
			trigger_data.data = data;
		if (dest_address)
			trigger_data.address = dest_address;
		const bThirdPartyClaiming = (dest_address && dest_address !== operator.getAddress());
		const paid_amount = bThirdPartyClaiming ? (amount - reward) : 0;
		let amountsByAsset = {};
		if (claimed_asset === staked_asset)
			amountsByAsset[staked_asset] = paid_amount + stake;
		else {
			amountsByAsset[staked_asset] = stake;
			if (bThirdPartyClaiming)
				amountsByAsset[claimed_asset] = paid_amount;
		}
		if (staked_asset === 'base')
			amountsByAsset[staked_asset] += 2000;
		const claim_txid = await dag.sendPayment({
			to_address: bridge_aa,
			amountsByAsset,
			data: trigger_data,
			is_aa: true,
		});
		console.log(`sent claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}: ${claim_txid}`);
		return claim_txid;
	}

	async sendClaimFromPooledAssistant({ assistant_aa, amount, reward, sender_address, dest_address, data, txid, txts }) {
		if (!dest_address)
			throw Error(`no dest address in assistant claim`);
	//	if (dest_address === operator.getAddress())
	//		throw Error(`assistant claim for oneself`);
		amount = amount.toNumber();
		reward = reward.toNumber();
		let trigger_data = {
			address: dest_address,
			sender_address,
			amount,
			reward,
			txid,
			txts,
		};
		if (data)
			trigger_data.data = data;
		const claim_txid = await dag.sendAARequest(assistant_aa, trigger_data);
		console.log(`sent assistant claim for ${amount} with reward ${reward} sent in tx ${txid} from ${sender_address}: ${claim_txid}`);
		return claim_txid;
	}

	async sendChallenge(bridge_aa, claim_num, stake_on, asset, counterstake) {
		const txid = await dag.sendPayment({
			to_address: bridge_aa,
			asset: asset,
			amount: counterstake.toNumber() + (asset === 'base' ? 2000 : 0), // ethers.BigNumber
			data: { stake_on, claim_num },
			is_aa: true,
		});
		console.log(`sent counterstake ${counterstake} for "${stake_on}" to challenge claim ${claim_num}: ${txid}`);
		return txid;
	}

	async sendChallengeFromPooledAssistant(assistant_aa, claim_num, stake_on, counterstake) {
		const txid = await dag.sendAARequest(assistant_aa, { stake_on, claim_num, stake: counterstake.toNumber() });
		console.log(`sent assistant counterstake ${counterstake} for "${stake_on}" to challenge claim ${claim_num}: ${txid}`);
		return txid;
	}

	async sendWithdrawalRequest(bridge_aa, claim_num, to_address) {
		let data = { withdraw: 1, claim_num };
		if (to_address)
			data.address = to_address;
		const txid = await dag.sendAARequest(bridge_aa, data);
		console.log(`sent withdrawal request on claim ${claim_num} to ${to_address || 'self'}: ${txid}`);
		return txid;
	}



	startWatchingExportAA(export_aa) {
		startWatchingAA(export_aa);
	}

	startWatchingImportAA(import_aa) {
		startWatchingAA(import_aa);
	}

	startWatchingExportAssistantAA(export_aa) {
		startWatchingAA(export_aa);
	}

	startWatchingImportAssistantAA(import_aa) {
		startWatchingAA(import_aa);
	}


	async onAAResponse(objAAResponse) {
		const unlock = await mutex.lock('onAAResponse');
		console.log(`AA response:`, JSON.stringify(objAAResponse, null, 2));

		const { aa_address, trigger_address, trigger_unit, response_unit, response, timestamp, bounced } = objAAResponse;
		if (!timestamp)
			throw Error(`no timestamp in AA response`);
		
		if (bounced && trigger_address === operator.getAddress())
			return unlock(`=== our request ${trigger_unit} bounced with error ` + response.error);
		if (bounced)
			return unlock(`skipping bounced request ${trigger_unit} ` + response.error);
	//	if (objAAResponse.trigger_address === operator.getAddress())
	//		return console.log(`skipping our request ${objAAResponse.trigger_unit}`);
		
		const { responseVars } = response;

		const objJoint = await dag.readJoint(trigger_unit);
		const objUnit = objJoint.unit;
		const trigger = aa_composer.getTrigger(objUnit, aa_address);
		if (!trigger.data)
			return unlock(`no data message in trigger ${trigger_unit}`);

		// updated symbol
		if (aa_address === conf.token_registry_aa) {
			if (!response_unit)
				return unlock(`no response unit from token registry, trigger ${trigger_unit}`);
			const objResponseJoint = await dag.readJoint(response_unit);
			const objResponseUnit = objResponseJoint.unit;
			const dataMessage = objResponseUnit.messages.find(m => m.app === 'data');
			if (!dataMessage)
				return unlock(`no data message in response from token registry, trigger ${trigger_unit}`);
			const { asset, name } = dataMessage.payload;
			if (!asset || !name)
				return unlock(`no asset or name in response from token registry, trigger ${trigger_unit}`);
			const rows = await db.query("SELECT bridge_id, home_asset=? AS is_home FROM bridges WHERE home_asset=? OR foreign_asset=?", [asset, asset, asset]);
			if (rows.length === 0)
				return unlock(`new name ${name} of unrelated asset ${asset}, trigger ${trigger_unit}`);
			for (let { bridge_id, is_home } of rows) {
				const field = is_home ? 'home_symbol' : 'foreign_symbol';
				console.log(`new ${field} in bridge ${bridge_id}: ${name}`);
				await db.query(`UPDATE bridges SET ${field}=? WHERE bridge_id=?`, [name, bridge_id]);
			}
			return unlock();
		}

		// new export AA
		if (aa_address === conf.export_factory_aa) {
			if (!responseVars)
				throw Error(`no responseVars in response from export factory`);
			const export_aa = responseVars.address;
			if (!export_aa)
				throw Error(`no address in response from export factory`);
			console.log(`new export AA ${export_aa}`);
		//	const params = await dag.readAAStateVar(aa_address, 'export_' + export_aa);
			const bAdded = await transfers.handleNewExportAA(export_aa, this.network, trigger.data.asset || 'base', trigger.data.asset_decimals, trigger.data.foreign_network, trigger.data.foreign_asset);
			if (bAdded)
				startWatchingAA(export_aa);
			return unlock();
		}
		
		// new import AA
		if (aa_address === conf.import_factory_aa) {
			if (!responseVars)
				return unlock(`no responseVars in response from import factory`);
			const import_aa = responseVars.address;
			if (!import_aa)
				throw Error(`no address in response from import factory`);
			console.log(`new import AA ${import_aa}`);
			const params = await dag.readAAStateVar(aa_address, 'import_' + import_aa);
			const bAdded = await transfers.handleNewImportAA(import_aa, trigger.data.home_network, trigger.data.home_asset, this.network, params.asset, trigger.data.asset_decimals, trigger.data.stake_asset || 'base');
			if (bAdded)
				startWatchingAA(import_aa);
			return unlock();
		}

		// new assistant AA
		if (aa_address === conf.export_assistant_factory_aa || aa_address === conf.import_assistant_factory_aa) {
			const side = aa_address === conf.export_assistant_factory_aa ? 'export' : 'import';
			if (!responseVars)
				return unlock(`no responseVars in response from ${side} assistant factory`);
			const assistant_aa = responseVars.address;
			if (!assistant_aa)
				throw Error(`no address in response from ${side} assistant factory`);
			console.log(`new ${side} assistant AA ${assistant_aa}`);
			const params = await dag.readAAStateVar(aa_address, 'assistant_' + assistant_aa);
			if (params.manager !== operator.getAddress())
				return unlock(`new assistant ${assistant_aa} with another manager, will skip`);
			const bAdded = await transfers.handleNewAssistantAA(side, assistant_aa, params.bridge_aa);
			if (bAdded)
				startWatchingAA(assistant_aa);
			return unlock();
		}
		
		
		/*
		if (responseVars.asset) { // asset defined on an import AA by circumventing the factory
			const definition = await dag.loadAA(aa_address);
			const base_aa = definition[1].base_aa;
			const params = definition[1].params;
			if (!base_aa)
				return console.log(`not a parameterized AA: ${aa_address}`);
			if (!conf.import_base_aas.includes(base_aa))
				return console.log(`not an import AA: ${aa_address}`);
			const asset = responseVars.asset;
			await transfers.handleNewImportAA(aa_address, params.home_network, params.home_asset, 'Obyte', asset, params.asset_decimals, params.stake_asset || 'base');
			return console.log(`asset defined by import AA ${aa_address}: ${asset}`);
		}*/

		const bridge = await transfers.getBridgeByAddress(aa_address);
		if (!bridge)
			return unlock(`response from AA ${aa_address} that doesn't belong to any bridge`);
		const { bridge_id, export_aa, import_aa, home_asset, foreign_asset, stake_asset } = bridge;
		
		const message = responseVars && responseVars.message || '';
		let new_claim_num = responseVars && responseVars.new_claim_num;
	//	if (!new_claim_num && message.startsWith('challenging period expires in')) { // temp hack
	//		console.log(`retrieving claim num from trigger ${trigger_unit}`);
	//		new_claim_num = await dag.readAAStateVar(aa_address, 'claim_num');
	//		if (!new_claim_num)
	//			throw Error(`no claim num after claim in trigger ${trigger_unit}`);
	//	}
		
		// new expatriation or repatriation
		if (message === 'started expatriation' && aa_address === export_aa || message === 'started repatriation' && aa_address === import_aa) {
			const type = (message === 'started expatriation' && aa_address === export_aa) ? 'expatriation' : 'repatriation';
			const amount = trigger.outputs[type === 'expatriation' ? home_asset : foreign_asset];
			if (!amount)
				throw Error(`started ${type} without payment in source asset? ${trigger_unit}`);
			const reward = trigger.data.reward || 0;
			const dest_address = trigger.data[type === 'expatriation' ? 'foreign_address' : 'home_address'];
			if (!dest_address)
				throw Error(`no dest address in transfer ${trigger_unit}`);
			const data = responseVars.data || ''; // json-stringified in the correct order
			await transfers.addTransfer({ bridge_id, type, amount, reward, sender_address: trigger_address, dest_address, data, txid: trigger_unit, txts: timestamp });
		}
		// new claim
		else if (new_claim_num) {
			if (!trigger.data.txid || !trigger.data.amount)
				throw Error(`no trigger data in claim ${trigger_unit}`);
			const type = (aa_address === export_aa) ? 'repatriation' : 'expatriation';
			const dest_address = trigger.data.address || trigger_address;
			const claimant_address = trigger_address;
			const amount = parseFloat(trigger.data.amount); // it might be a string
			const reward = parseFloat(trigger.data.reward || 0); // it might be a string
			const asset = type === 'expatriation' ? stake_asset : home_asset;
			let stake = trigger.outputs[asset];
			if (!stake)
				throw Error(`no stake in claim ${trigger_unit} of tx ${trigger.data.txid}`);
			if (asset === 'base')
				stake -= 2000;
			if (type === 'repatriation') {
				const paid_amount = (dest_address !== trigger_address) ? amount - reward : 0;
				stake -= paid_amount;
			}
			const data = trigger.data.data ? string_utils.getJsonSourceString(trigger.data.data) : '';
			await transfers.handleNewClaim(bridge, type, new_claim_num, trigger.data.sender_address, dest_address, claimant_address, data, amount, reward, stake, trigger.data.txid, trigger.data.txts, trigger_unit);
		}
		// challenge
		else if (message.startsWith('current outcome')) {
			if (message.startsWith('current outcome stays'))
				console.log(`got challenge ${trigger_unit} for "${trigger.data.stake_on}" that didn't change the outcome`);
			else if (message.startsWith('current outcome became'))
				console.log(`got challenge ${trigger_unit} for "${trigger.data.stake_on}" that changed the outcome`);
			const claim_num = trigger.data.claim_num;
			if (!trigger.data.stake_on || !claim_num)
				throw Error(`no trigger data in challenge ${trigger_unit}`);
			const type = (aa_address === export_aa) ? 'repatriation' : 'expatriation';
			const asset = type === 'expatriation' ? stake_asset : home_asset;
			let stake = trigger.outputs[asset];
			if (!stake)
				throw Error(`no stake in challenge ${trigger_unit} on claim ${claim_num}`);
			if (asset === 'base')
				stake -= 2000;
			await transfers.handleChallenge(bridge, type, claim_num, trigger_address, trigger.data.stake_on, stake, trigger_unit);
		}
		// first withdrawal
		else if (message.startsWith('finished claim ')) {
			const claim_num = trigger.data.claim_num;
			if (!trigger.data.withdraw || !claim_num)
				throw Error(`no trigger data in withdrawal ${trigger_unit}`);
			const type = (aa_address === export_aa) ? 'repatriation' : 'expatriation';
			await transfers.handleWithdrawal(bridge, type, claim_num, trigger_unit);
		}
		// other withdrawals
		else {
			console.log(`ignored trigger ${trigger_unit} with message ${responseVars && responseVars.message}`);
		}
		unlock();
	}

	async getSymbol(asset) {
		if (asset === 'base')
			return 'GBYTE';
		return await dag.readAAStateVar(conf.token_registry_aa, 'a2s_' + asset);
	}

	async waitUntilSynced() {
		console.log(`waiting for ${this.network} to sync`);
		if (conf.bLight) {
			const light_wallet = require("ocore/light_wallet.js");
			await light_wallet.waitUntilFirstHistoryReceived();
			await network.waitTillSyncIdle();
		}
		else
			await network.waitUntilCatchedUp();
		console.log(`${this.network} is synced`);
	}

	async refresh() {
		if (conf.bLight) {
			const light_wallet = require("ocore/light_wallet.js");
			light_wallet.refreshLightClientHistory();
			await light_wallet.waitUntilHistoryRefreshDone();
			await network.waitTillSyncIdle();
			return true;
		}
		return false;
	}

	async startWatchingSymbolUpdates() {
		walletGeneral.addWatchedAddress(conf.token_registry_aa);
	}

	async startWatchingFactories() {
		walletGeneral.addWatchedAddress(conf.export_factory_aa);
		walletGeneral.addWatchedAddress(conf.import_factory_aa);
	}

	async startWatchingAssistantFactories() {
		walletGeneral.addWatchedAddress(conf.export_assistant_factory_aa);
		walletGeneral.addWatchedAddress(conf.import_assistant_factory_aa);
	}

	// called on start-up to handle missed transfers
	async catchup() {
		await this.waitUntilSynced();
		const unlock = await mutex.lock('onAAResponse'); // take the last place in the queue after all real AA responses
		unlock();
		console.log(`catching up ${this.network} done`);
	}

	constructor() {

		if (bCreated)
			throw Error("Obyte class already created, must be a singleton");
		bCreated = true;

		// make sure 'this' points to the class when calling the event handler
		eventBus.on("aa_response", this.onAAResponse.bind(this));

		eventBus.on("message_for_light", (ws, subject, body) => {
			switch (subject) {
				case 'light/aa_response':
					// we don't have the trigger unit in our db yet, trigger a refresh to get it
					console.log(`will refresh`);
					const light_wallet = require("ocore/light_wallet.js");
					light_wallet.refreshLightClientHistory();
				//	this.onAAResponse.call(this, body);
					break;
			}
		});
	//	console.error('--- network', this.network)

	}
}

function startWatchingAA(aa) {
	network.addLightWatchedAa(aa);
	walletGeneral.addWatchedAddress(aa);
}

module.exports = Obyte;
