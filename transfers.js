"use strict";
const _ = require('lodash');
const { ethers: { BigNumber, utils } } = require("ethers");
const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const mutex = require('ocore/mutex.js');
const db = require('ocore/db.js');
const network = require('ocore/network.js');
const validationUtils = require('ocore/validation_utils.js');
const notifications = require('./notifications.js');

const Obyte = require('./obyte.js');
const Ethereum = require('./ethereum.js');
const BSC = require('./bsc.js');
const Polygon = require('./polygon.js');
const Kava = require('./kava.js');
const { wait, asyncCallWithTimeout } = require('./utils.js');

const networkApi = {};
let maxAmounts;
let bCatchingUp = true;
let bCatchingUpOrHandlingPostponedEvents = true;
let unconfirmedClaims = {}; // transfer_id => {claim_txid, ts}
let unconfirmeWithdrawals = {};

async function getBridge(bridge_id) {
	const [bridge] = await db.query("SELECT * FROM bridges WHERE bridge_id=?", [bridge_id]);
	if (!bridge)
		throw Error(`bridge not found: ${bridge_id}`);
	return bridge;
}


async function getBridgeByAddress(bridge_aa, bThrowIfNotFound) {
	const [bridge] = await db.query("SELECT * FROM bridges WHERE export_aa=? OR import_aa=?", [bridge_aa, bridge_aa]);
	if (!bridge && bThrowIfNotFound)
		throw Error(`bridge not found by address ${bridge_aa}`);
	return bridge;
}


async function addTransfer(transfer, bRewritable) {
	const { bridge_id, type, amount, reward, sender_address, dest_address, data, txid, txts } = transfer;
	if (bRewritable) { // rewritable ledgers such as Ethereum
		// check if the same tx was dropped as a result of a reorg and then added again with the same block timestamp (e.g. its chain won again)
		const db_transfers = await db.query("SELECT * FROM transfers WHERE txid=? AND txts=? AND bridge_id=? AND amount=? AND reward=? AND sender_address=? AND dest_address=? AND data=?", [txid, txts, bridge_id, amount.toString(), reward.toString(), sender_address, dest_address, data]);
		if (db_transfers.length > 1)
			throw Error(`more than 1 transfer with txid=${txid}, txts=${txts}, bridge_id=${bridge_id}`);
		const [db_transfer] = db_transfers;
		if (db_transfer && !db_transfer.is_confirmed) { // reuse the existing record
			await db.query("UPDATE transfers SET is_confirmed=1 WHERE transfer_id=?", [db_transfer.transfer_id]);
			return console.log(`re-confirmed the existing transfer ${db_transfer.transfer_id}`);
		}
	}
	console.log(`inserting transfer`, transfer);
	const res = await db.query("INSERT " + db.getIgnore() + " INTO transfers (bridge_id, type, amount, reward, sender_address, dest_address, data, txid, txts) VALUES (?,?, ?,?, ?,?,?, ?,?)", [bridge_id, type, amount.toString(), reward.toString(), sender_address, dest_address, data, txid, txts]);
	const bInserted = res.insertId && res.affectedRows;
	console.log(bInserted ? `inserted transfer ${res.insertId}` : `duplicate transfer`);
	if (bInserted) {
		// check that the numbers were inserted correctly
		const [t] = await db.query("SELECT amount, reward FROM transfers WHERE transfer_id=?", [res.insertId]);
		if (t.amount !== amount.toString() || t.reward !== reward.toString())
			throw Error(`number mismatch: tried to insert ${amount.toString()}, ${reward.toString()} but inserted ${t.amount}, ${t.reward}`);
	}
	console.log(`emitting txid`, txid);
	eventBus.emit(txid);
	if (bCatchingUp)
		return console.log(`will not try to claim transfer ${txid} as we are still catching up`);
	if (bInserted)
		await handleTransfer(transfer);
}

async function handleTransfer(transfer) {
	const { bridge_id, type, sender_address, dest_address, data, txid, txts, transfer_id } = transfer;
	let { amount, reward } = transfer;

	async function markAsBad(msg) {
		await db.query("UPDATE transfers SET is_bad=1 WHERE txid=? AND bridge_id=?", [txid, bridge_id]);
		return console.log(msg);
	}

	if (typeof reward === 'number' && !validationUtils.isInteger(reward))
		return markAsBad(`invalid reward ${reward} in transfer ${txid} from ${sender_address} on bridge ${bridge_id}, will not claim`);
	if (!BigNumber.isBigNumber(amount))
		amount = BigNumber.from(amount);
	if (!BigNumber.isBigNumber(reward))
		reward = BigNumber.from(reward);
	const bridge = await getBridge(bridge_id);
	const { export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_asset, foreign_asset, stake_asset, home_network, foreign_network, home_asset_decimals, foreign_asset_decimals, home_symbol, foreign_symbol } = bridge;
	const bCompleteBridge = import_aa && export_aa;
	if (!bCompleteBridge)
		return console.log(`will not claim transfer ${txid} from ${sender_address} on bridge ${bridge_id} as the bridge is still incomplete`);
	const src_network = type === 'expatriation' ? home_network : foreign_network;
	const dst_network = type === 'expatriation' ? foreign_network : home_network;
	const bridge_aa = type === 'expatriation' ? import_aa : export_aa;
	const assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;
	if (!assistant_aa && !conf.bUseOwnFunds)
		return console.log(`not using own funds, will not claim transfer ${txid} from ${sender_address} on bridge ${bridge_id}`);
	const src_asset = type === 'expatriation' ? home_asset : foreign_asset;
	const claimed_asset = type === 'expatriation' ? foreign_asset : home_asset;
	const claimed_symbol = type === 'expatriation' ? foreign_symbol : home_symbol;
	const staked_asset = type === 'expatriation' ? stake_asset : home_asset;
	const src_asset_decimals = type === 'expatriation' ? home_asset_decimals : foreign_asset_decimals;
	const dst_asset_decimals = type === 'expatriation' ? foreign_asset_decimals : home_asset_decimals;
	const dst_amount = getDestAmount(amount, src_asset_decimals, dst_asset_decimals);
	const dst_reward = getDestAmount(reward, src_asset_decimals, dst_asset_decimals);
	// someone might send an amount with excessive precision such as 1.0000000000000001 ETH to a network with smaller precision, reject
	if (!amountsMatch(amount, src_asset_decimals, dst_amount, dst_asset_decimals))
		return markAsBad(`transfer ${txid} on bridge ${bridge_id} amounts do not match: src ${amount.toString()}/${src_asset_decimals} dst ${dst_amount.toString()}/${dst_asset_decimals}, will not claim`);
	if (!amountsMatch(reward, src_asset_decimals, dst_reward, dst_asset_decimals))
		return markAsBad(`transfer ${txid} on bridge ${bridge_id} rewards do not match: src ${reward.toString()}/${src_asset_decimals} dst ${dst_reward.toString()}/${dst_asset_decimals}, will not claim`);
	const fDstAmount = parseFloat(dst_amount.toString()) / 10 ** dst_asset_decimals;
	const fDstReward = parseFloat(dst_reward.toString()) / 10 ** dst_asset_decimals;
	const src_api = networkApi[src_network];
	const dst_api = networkApi[dst_network];
	if (!dst_api && conf['disable' + dst_network])
		return console.log(`${dst_network} disabled, will not claim transfer ${txid}`);

	if (!dst_api.isValidAddress(dest_address))
		return markAsBad(`invalid dest address ${dest_address} in transfer ${txid}, will not claim`);

	if (data && !dst_api.isValidData(data))
		return markAsBad(`invalid data ${data} in transfer ${txid}, will not claim`);

	const bThirdPartyClaiming = !dst_api.isMyAddress(dest_address);
	if (!conf.bClaimForOthers && bThirdPartyClaiming)
		return console.log(`not claiming for others and transfer ${txid} is not to me`);
	if (bThirdPartyClaiming) {
		if (reward.lt(0))
			return console.log(`the sender ${sender_address} doesn't want their tx ${txid} to be claimed by third parties, they set a negative reward`);
		if (reward.isZero())
			return console.log(`zero reward in transfer ${txid} from ${sender_address}`);
		const fAmount = parseFloat(utils.formatEther(amount));
		const fReward = parseFloat(utils.formatEther(reward));
		if (fReward < conf.min_reward_ratio * fAmount)
			return console.log(`too small reward in transfer ${txid} from ${sender_address}`);
		const fMinReward = await dst_api.getMinReward(type, claimed_asset, src_network, src_asset, !!assistant_aa);
		console.log({ fMinReward });
		if (fMinReward === null)
			return console.log(`unable to determine min reward for transfer ${txid} from ${sender_address} of ${fAmount} ${claimed_asset}, will not claim`);
		if (fDstReward < fMinReward)
			return console.log(`the reward in transfer ${txid} from ${sender_address} is only ${fDstReward} which is less than the minimum ${fMinReward} to justify the fees, will not claim`);
		const fDstNetReward = fDstReward - fMinReward;
		if (fDstNetReward < conf.min_reward_ratio * fDstAmount)
			return console.log(`too small net reward ${fDstNetReward} in transfer ${txid} from ${sender_address}`);
	}

	const sendClaim = async () => {

		const unlock = await mutex.lock(dst_network);
		console.log(`will claim a transfer on ${dst_network} from ${sender_address} amount ${dst_amount} reward ${dst_reward} txid ${txid}`);

		// check if the transfer got removed while we were waiting
		let db_transfers = await db.query("SELECT * FROM transfers WHERE txid=? AND bridge_id=? AND amount=? AND reward=? AND sender_address=? AND dest_address=? AND data=?", [txid, bridge_id, amount.toString(), reward.toString(), sender_address, dest_address, data]);
		if (db_transfers.length !== 1) {
			if (db_transfers.length === 0)
				throw Error(`no transfers found in db for transfer tx ${txid}`);
			db_transfers = db_transfers.filter(t => t.is_confirmed);
			if (db_transfers.length !== 1)
				throw Error(`${db_transfers.length} confirmed transfers found in db for transfer tx ${txid}`);
		}
		const [{ transfer_id, is_confirmed }] = db_transfers;
		if (!is_confirmed)
			return unlock(`transfer ${txid} from ${sender_address} got removed, will not claim`);

		// check if it was claimed while we were waiting
		const [db_claim] = await db.query("SELECT * FROM claims WHERE transfer_id=?", [transfer_id]);
		if (db_claim)
			return unlock(`transfer ${txid} #${transfer_id} from ${sender_address} already claimed`);
		if (unconfirmedClaims[transfer_id])
			return unlock(`we have already claimed transfer ${txid} #${transfer_id} from ${sender_address} in tx ${unconfirmedClaims[transfer_id].claim_txid} and it's still unconfirmed`);
		
		let stake = await dst_api.getRequiredStake(bridge_aa, dst_amount);
		stake = BigNumber.from(stake);
		if (type === 'expatriation' && dst_network === 'Obyte') // we use oracle price, which might change, add 10%
			stake = stake.mul(110).div(100);
		let bClaimFromPooledAssistant = !!assistant_aa;
		if (bClaimFromPooledAssistant) {
			const bAssistantHasEnoughBalance = (staked_asset === claimed_asset)
				? dst_amount.add(stake).lt(await dst_api.getBalance(assistant_aa, staked_asset))
				: (stake.lt(await dst_api.getBalance(assistant_aa, staked_asset))
					&& dst_amount.lt(await dst_api.getBalance(assistant_aa, claimed_asset)));
			if (bAssistantHasEnoughBalance)
				console.log(`will claim ${txid} from assistant AA ${assistant_aa}`);
			else {
				console.log(`assistant AA ${assistant_aa} has insufficient balance to claim ${txid}, will try to claim myself`);
				bClaimFromPooledAssistant = false;
			}
		}
		if (!bClaimFromPooledAssistant) {
			console.log({staked_asset, claimed_asset}, `dst amount ${dst_amount}, stake ${stake}, bal ${await dst_api.getMyBalance(staked_asset)}`)
			const bHaveEnoughBalance = bThirdPartyClaiming
				? ((staked_asset === claimed_asset)
					? dst_amount.add(stake).lte(await dst_api.getMyBalance(staked_asset))
					: (stake.lte(await dst_api.getMyBalance(staked_asset))
						&& dst_amount.lte(await dst_api.getMyBalance(claimed_asset))))
				: stake.lte(await dst_api.getMyBalance(staked_asset));
			if (!bHaveEnoughBalance) {
				if (!transfer_id || transfer_id > 6947) // transfer_id available only when retrying from the db
					notifications.notifyAdmin(`not enough balance to claim ${dst_amount / 10 ** dst_asset_decimals} ${claimed_symbol} on ${dst_network} (${claimed_asset}) in transfer ${txid} from ${sender_address} (${src_network}) to ${dest_address}`);
				return unlock();
			}
		}
		let claim_txid;
		if (bClaimFromPooledAssistant) {
			claim_txid = await dst_api.sendClaimFromPooledAssistant({ assistant_aa, amount: dst_amount, reward: dst_reward, claimed_asset, staked_asset, sender_address, dest_address, data, txid, txts });
			if (!claim_txid) {
				console.log(`claiming from pooled assistant failed, will try to claim myself`);
				bClaimFromPooledAssistant = false;
			}
		}
		if (!bClaimFromPooledAssistant)
			claim_txid = await dst_api.sendClaim({ bridge_aa, amount: dst_amount, reward: dst_reward, claimed_asset, stake, staked_asset, sender_address, dest_address, data, txid, txts });
		console.log(`claimed transfer from ${sender_address} amount ${dst_amount} reward ${dst_reward}: ${claim_txid}`);
		if (claim_txid)
			unconfirmedClaims[transfer_id] = { claim_txid, ts: Date.now() };
		setTimeout(updateMaxAmounts, 60 * 1000);
		unlock();
	};

	let min_tx_age = await dst_api.getMinTxAge(bridge_aa);
	if (BigNumber.isBigNumber(min_tx_age))
		min_tx_age = min_tx_age.toNumber();
	const timeout = txts + min_tx_age + src_api.getMinTransferAge() - Math.floor(Date.now() / 1000);
	if (timeout > 0) {
		console.log(`will wait for ${timeout} sec before claiming transfer ${txid} from ${sender_address}`);
		setTimeout(sendClaim, timeout * 1000);
	}
	else
		sendClaim(); // don't await, release the lock that encloses addTransfer as soon as possible. Also, sendClaim() acquires another lock which might lead to deadlocka
}

// After a transfer was removed, one of 4 things can happen:
// - it is removed forever
// - it will be re-added with the same timestamp in the same block (reorg back to an earlier version of the chain)
// - it will be re-added with the same timestamp in another block
// - it will be re-added with another timestamp in another block
// We can oscillate beween additions and removals any number of times.
// We might not receive a 'removed' event if we go offline. Then, we might receive an event when the tx is re-added with another timestamp and our unique index would prevent insertion

async function removeTransfer(transfer) {
	const { bridge_id, type, amount, reward, sender_address, dest_address, data, txid, txts } = transfer;
	const [db_transfer] = await db.query("SELECT * FROM transfers WHERE txid=? AND bridge_id=? AND is_confirmed=1", [txid, bridge_id]);
	if (!db_transfer)
		return console.log(`the transfer to be removed was not found: txid ${txid} on bridge ${bridge_id}`);
	const { transfer_id } = db_transfer;
	if (db_transfer.type !== type)
		throw Error(`type mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.amount !== amount.toString())
		throw Error(`amount mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.reward !== reward.toString())
		throw Error(`reward mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.sender_address !== sender_address)
		throw Error(`address mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.dest_address !== dest_address)
		throw Error(`dest_address mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.data !== data)
		throw Error(`data mismatch in removed transfer ${transfer_id}`);
	if (db_transfer.txts !== txts)
		throw Error(`txts mismatch in removed transfer ${transfer_id}`);
	const db_claims = await db.query("SELECT * FROM claims WHERE transfer_id=?", [transfer_id]);
	if (db_claims.length > 1)
		throw Error(`${db_claims.length} claims on transfer ${transfer_id}?`);
	await db.query("UPDATE transfers SET is_confirmed=NULL WHERE transfer_id=?", [transfer_id]);
	if (db_claims.length === 0)
		return console.log(`there were no claims on the removed transfer ${transfer_id} txid ${txid} on bridge ${bridge_id}`)
	const [{ claim_num }] = db_claims;
	// don't attack the claim immediately as the transfer can become valid again, re-check the affected claim later
	console.log(`there was a claim ${claim_num} on the removed transfer ${transfer_id}, will check it again later`);
	setTimeout(() => recheckClaim({ claim_num, bridge_id, type }), conf.recheck_timeout);
}


async function recheckClaim({ claim_num, bridge_id, type }) {
	console.log('rechecking claim', { claim_num, bridge_id, type });
	const [db_claim] = await db.query("SELECT * FROM claims WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge_id, type]);
	if (db_claim)
		throw Error(`claim ${claim_num} not found`);
	const { transfer_id, claim_txid } = db_claim;
	if (!transfer_id)
		throw Error(`no transfer_id in claim ${claim_num} ${claim_txid}`);
	let [transfer] = await db.query("SELECT * FROM transfers WHERE transfer_id=?", [transfer_id]);
	if (!transfer)
		throw Error(`transfer ${transfer_id} indicated by claim ${claim_num} not found`);
	if (transfer.is_confirmed)
		return console.log(`transfer ${transfer_id} indicated by claim ${claim_num} is confirmed again, no action`);
	// assume it was removed forever, attack
	const bridge = await getBridge(bridge_id);
	await attackClaim(bridge, type, claim_num, claim_txid);
}


async function attackClaim(bridge, type, claim_num, claim_txid) {
	if (!conf.bWatchdog)
		return console.log(`will skip attacking claim ${claim_txid} as watchdog function is off`);
	if (!conf.bAttack)
		return console.log(`will skip attacking claim ${claim_txid} as attacking function is off`);

	const { bridge_id, export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_asset, foreign_asset, stake_asset, home_network, foreign_network, home_asset_decimals, foreign_asset_decimals } = bridge;
	console.log(`will attack ${type} claim ${claim_num} in ${claim_txid} on bridge ${bridge_id}`);
	const bCompleteBridge = import_aa && export_aa;
	if (!bCompleteBridge)
		return console.log(`will not attack claim ${claim_num} in ${claim_txid} on bridge ${bridge_id} as the bridge is still incomplete`);
	const bridge_aa = type === 'expatriation' ? import_aa : export_aa;
	if (!bridge_aa)
		throw Error(`null aa in claim ${claim_num}`);
	const assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;
	if (!assistant_aa && !conf.bUseOwnFunds)
		return console.log(`not using own funds, will not attack claim ${claim_num} in ${claim_txid} on bridge ${bridge_id}`);
	const network = type === 'expatriation' ? foreign_network : home_network;
	const api = networkApi[network];
	const claim = await api.getClaim(bridge_aa, claim_num, false, false);
	console.log(`will attack new claim received in trigger ${claim_txid}`, claim);
	if (!claim)
		return notifications.notifyAdmin(`ongoing claim ${claim_num} not found, will not attack`);
	if (claim.current_outcome !== 'yes') // someone challenged it before us
		return console.log(`claim ${claim_num} already challenged`);
	if (claim.expiry_ts < Date.now() / 1000)
		return notifications.notifyAdmin(`challenging period expired in claim ${claim_num}`, `too late: the challenging period in claim ${claim_num} has already expired, will not attack\nbridge ${bridge_id} on ${network}, AA ${bridge_aa}\nclaim txid ${claim_txid}`);

	const required_counterstake = BigNumber.from(claim.challenging_target);
	const asset = type === 'expatriation' ? stake_asset : home_asset;
	if (!asset)
		throw Error(`null asset in claim ${claim_num}`);
	const counterstake = await getCounterstakeAmount(network, assistant_aa, required_counterstake, asset);
	if (counterstake.isZero())
		return notifications.notifyAdmin(`0 balance available to counterstake claim ${claim_num} received in tx ${claim_txid}`);
	if (counterstake.lt(required_counterstake))
		notifications.notifyAdmin(`counterstaking ${counterstake} out of ${required_counterstake} on claim ${claim_num} received in tx ${claim_txid}`);
	await sendChallenge(network, bridge_aa, assistant_aa, { claim_num, bridge_id, type }, 'no', asset, counterstake);
}


async function handleNewClaim(bridge, type, claim_num, sender_address, dest_address, claimant_address, data, amount, reward, stake, txid, txts, claim_txid) {

	if (!conf.bWatchdog)
		return console.log(`will skip claim ${claim_txid} as watchdog function is off`);

	const network = type === 'expatriation' ? bridge.foreign_network : bridge.home_network;
	const unlock = await mutex.lock(network);
	console.log(`handling claim ${claim_num} in tx ${claim_txid}`);

	const [db_claim] = await db.query("SELECT * FROM claims WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge.bridge_id, type]);
	if (db_claim)
		return unlock(`duplicate claim ${claim_num} in tx ${claim_txid}`);

	// make sure the opposite network is up to date and we know all the transfers initiated there
	const opposite_network = type === 'expatriation' ? bridge.home_network : bridge.foreign_network;
	if (!networkApi[opposite_network])
		return unlock(`opposite network ${opposite_network} not active, ignoring claim ${claim_txid}`);
	await networkApi[opposite_network].waitUntilSynced();
	if (!bridge.import_aa || !bridge.export_aa) // maybe it became complete now?
		bridge = await getBridge(bridge.bridge_id);
	
	const { bridge_id, export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_asset, foreign_asset, stake_asset, home_network, foreign_network, home_asset_decimals, foreign_asset_decimals } = bridge;
	const bCompleteBridge = import_aa && export_aa;
	const assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;

	let amountsValid = true;
	if (typeof amount === 'number' && !validationUtils.isPositiveInteger(amount))
		amountsValid = false;
	if (typeof reward === 'number' && !validationUtils.isInteger(reward))
		amountsValid = false;
	const txidValid = networkApi[opposite_network].isValidTxid(txid);
	
	// in case we need to delay handling of the claim
	const tryAgain = () => {
		console.log(`retrying handling of claim ${claim_num}`);
		handleNewClaim(bridge, type, claim_num, sender_address, dest_address, claimant_address, data, amount, reward, stake, txid, txts, claim_txid);
	};

	// sender_address and dest_address are case-sensitive! For Ethereum, use mixed case checksummed addresses only
	const findTransfers = async () => {
		const transfers = await db.query("SELECT * FROM transfers WHERE bridge_id=? AND txid=? AND txts=? AND sender_address=? AND dest_address=? AND type=? AND is_confirmed=1", [bridge_id, txid, txts, sender_address, dest_address, type]);
		console.log(`transfer candidates for ${txid}`, transfers);
		return transfers;
	};
	let transfers = [];
	if (!amountsValid)
		console.log(`invalid amounts in claim ${claim_num} claim tx ${claim_txid}, tx ${txid}, bridge ${bridge_id}`);
	else if (!txidValid)
		console.log(`invalid txid in claim ${claim_num} claim tx ${claim_txid}, tx ${txid}, bridge ${bridge_id}`);
	else
		transfers = await findTransfers();
	if (!transfers[0] && amountsValid && txidValid) {
		console.log(`no transfer found matching claim ${claim_num} of txid ${txid} in claim tx ${claim_txid} bridge ${bridge_id}`);
		const retryAfterTxOrTimeout = (timeout) => {
			const t = setTimeout(tryAgain, timeout * 1000);
			eventBus.once(txid, () => {
				console.log(`got txid event ${txid}`);
				clearTimeout(t);
				tryAgain();
			});
		};
		// it might be not confirmed yet
	//	const tx = await networkApi[opposite_network].getTransaction(txid);
		const stable_ts = await networkApi[opposite_network].getLastStableTimestamp();
		const bTooYoung = txts >= stable_ts;
		if (txts < Date.now() / 1000 + conf.max_ts_error && (bTooYoung || bCatchingUp)) {
			// schedule another check
			const timeout = bTooYoung ? (txts - stable_ts + 60) : 60;
			retryAfterTxOrTimeout(timeout);
			return unlock(`the claimed transfer ${claim_num} ${bTooYoung ? 'is too young' : 'not found while catching up'}, will check again in ${timeout} s, maybe it appears in the source chain`);
		}
		const bMightUpdate = await networkApi[opposite_network].refresh(txid);
		if (bMightUpdate) { // try again
			console.log(`will try to find the transfer ${txid} again`);
			// if we see a new transfer after refresh, we'll try to claim it but the destination network is still locked by mutex here. We'll finish here first, insert this claim, unlock the mutex, and our claim attempt will see that a claim already exists
			transfers = await findTransfers();
			if (transfers.length === 0) { // events might be emitted but not handled yet
				await wait(30000);
				transfers = await findTransfers();
			}
		}
	}

	const checkTransfer = (transfer) => {
		if (!bCompleteBridge)
			throw Error(`found a transfer ${transfer.transfer_id} on an incomplete bridge ${bridge_id}, claim ${claim_num} in tx ${claim_txid}`);
		if (home_asset_decimals === null || foreign_asset_decimals === null)
			throw Error(`home_asset_decimals=${home_asset_decimals}, foreign_asset_decimals=${foreign_asset_decimals} on complete bridge ${bridge_id}, claim ${claim_num} in tx ${claim_txid}`);
		if (!networkApi[network].dataMatches(transfer.data, data)) {
			console.log(`data strings do not match in claim ${claim_num} tx ${claim_txid}: expected ${transfer.data}, got ${data}, bridge ${bridge_id}`);
			return false;
		}
		const src_asset_decimals = type === 'expatriation' ? home_asset_decimals : foreign_asset_decimals;
		const dst_asset_decimals = type === 'expatriation' ? foreign_asset_decimals : home_asset_decimals;
		if (!amountsMatch(transfer.amount, src_asset_decimals, amount, dst_asset_decimals)) {
			console.log(`transfer amounts do not match in claim ${claim_num} tx ${claim_txid}: expected ${transfer.amount} with ${src_asset_decimals} decimals, got ${amount} with ${dst_asset_decimals} decimals, bridge ${bridge_id}`);
			return false;
		}
		if (!amountsMatch(transfer.reward, src_asset_decimals, reward, dst_asset_decimals)) {
			console.log(`transfer rewards do not match in claim ${claim_num} tx ${claim_txid}: expected ${transfer.reward} with ${src_asset_decimals} decimals, got ${reward} with ${dst_asset_decimals} decimals, bridge ${bridge_id}`);
			return false;
		}
		return true;
	};
	transfers = transfers.filter(checkTransfer);
	if (transfers.length > 1)
		throw Error(`more than 1 transfer? ${JSON.stringify(transfers)}`);
	const transfer = transfers[0];
	if (transfer) {
		const min_transfer_age = networkApi[opposite_network].getMinTransferAge();
		if (transfer && txts > Date.now() / 1000 - min_transfer_age) {
			setTimeout(tryAgain, (txts + min_transfer_age + 1) * 1000 - Date.now());
			return unlock(`claim ${claim_num} in tx ${claim_txid} appears to be ok but it's too young, will delay its handling to avoid reorgs`);
		}
	}
	console.log(`${transfer ? 'valid' : 'invalid'} claim ${claim_num}`);
	const transfer_id = transfer ? transfer.transfer_id : null;
	if (transfer) { // valid claim
		const [db_claim] = await db.query("SELECT * FROM claims WHERE transfer_id=?", [transfer_id]);
		if (db_claim)
			throw Error(`duplicate valid claim in trigger ${claim_txid}, previous ${db_claim.claim_num}`);
	}

	const my_stake = (networkApi[network].isMyAddress(claimant_address) || claimant_address === assistant_aa) ? stake.toString() : '0';

	// log the claim either way, valid or not valid
	await db.query("INSERT INTO claims (claim_num, bridge_id, type, amount, reward, sender_address, dest_address, claimant_address, data, txid, txts, transfer_id, claim_txid, my_stake) VALUES (?,?,?, ?,?, ?,?,?, ?, ?,?, ?, ?,?)", [claim_num, bridge_id, type, amount.toString(), reward.toString(), sender_address, dest_address, claimant_address, data, txid, txts, transfer_id, claim_txid, my_stake]);

	if (!transfer) { // not valid, attack it
		eventBus.emit('fraudulent_claim', bridge, type, claim_num, sender_address, dest_address, claimant_address, data, amount, reward, stake, txid, txts, claim_txid);
		await attackClaim(bridge, type, claim_num, claim_txid);
	}
	else
		delete unconfirmedClaims[transfer_id];
	unlock();
}


async function handleChallenge(bridge, type, claim_num, address, stake_on, stake, challenge_txid) {
	if (!conf.bWatchdog)
		return console.log(`will skip challenge ${challenge_txid} as watchdog function is off`);

	const network = type === 'expatriation' ? bridge.foreign_network : bridge.home_network;
	const unlock = await mutex.lock(network);
	console.log(`handling challenge of claim ${claim_num} with "${stake_on}" in tx ${challenge_txid}`);
	
	const [db_challenge] = await db.query("SELECT * FROM challenges WHERE challenge_txid=? AND bridge_id=?", [challenge_txid, bridge.bridge_id]);
	if (db_challenge)
		return unlock(`duplicate challenge on claim ${claim_num} in tx ${challenge_txid}`);
	
	if (!bridge.import_aa || !bridge.export_aa) // maybe it became complete while we were waiting for the lock?
		bridge = await getBridge(bridge.bridge_id);
	
	const { bridge_id, export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_asset, foreign_asset, stake_asset, home_network, foreign_network } = bridge;
	const bCompleteBridge = import_aa && export_aa;
	const bridge_aa = type === 'expatriation' ? import_aa : export_aa;
	if (!bridge_aa)
		throw Error(`null aa in challenge ${challenge_txid} on claim ${claim_num}`);
	const assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;
	const api = networkApi[network];
	const claim = await api.getClaim(bridge_aa, claim_num, false, false);
	console.log(`claim challenged in trigger ${challenge_txid}`, claim);
	if (!claim) { // no claim at all or it's already finished
		eventBus.emit('challenge', bridge, type, claim_num, address, stake_on, stake, challenge_txid);
		return unlock(`ongoing claim ${claim_num} challenged in ${challenge_txid} not found, will skip`);
	}

	const valid_outcome = await getValidOutcome({ claim_num, bridge_id, type }, false);
	// this can happen if the claim was too young when received and we delayed its processing but someone challenged it in the mean time. Will wait and retry.
	if (valid_outcome === null) {
		setTimeout(() => {
			handleChallenge(bridge, type, claim_num, address, stake_on, stake, challenge_txid);
		}, 60 * 1000);
		return unlock(`claim ${claim_num} challenged in ${challenge_txid} is not known yet, will retry`);
	}
	eventBus.emit('challenge', bridge, type, claim_num, address, stake_on, stake, challenge_txid, claim, valid_outcome);

	const my_stake = await getMyStake({ claim_num, bridge_id, type });
	if (my_stake && my_stake !== '0' && !api.isMyAddress(address) && address !== assistant_aa)
		notifications.notifyAdmin(`my claim ${claim_num} challenged by ${address}`, `network ${network}, bridge ${bridge_id}, AA ${bridge_aa}\nstaked ${stake.toString()} on '${stake_on}'\nvalid outcome ${valid_outcome}, current outcome ${claim.current_outcome}, challenge txid ${challenge_txid}, type ${type}`);

//	if (claim.type !== type)
//		throw Error(`wrong type in claim ${claim_num}`);
	
	await db.query("INSERT INTO challenges (claim_num, bridge_id, type, address, stake_on, stake, challenge_txid) VALUES(?,?, ?,?, ?,?, ?)", [claim_num, bridge_id, type, address, stake_on, stake.toString(), challenge_txid]);
	
	if (stake_on !== claim.current_outcome)
		return unlock(`the challenge ${challenge_txid} with "${stake_on}" on claim ${claim_num} didn't override the current outcome "${claim.current_outcome}", no need to act`);

	if (claim.current_outcome !== valid_outcome) { // wrong outcome leads, attack it
		if (!bCompleteBridge)
			return unlock(`will not attack challenge ${challenge_txid} of claim ${claim_num} on bridge ${bridge_id} as the bridge is still incomplete`);
		if (!conf.bAttack)
			return unlock(`will skip challenge ${challenge_txid} as attacking function is off`);
		const asset = type === 'expatriation' ? stake_asset : home_asset;
		if (!asset)
			throw Error(`null asset in challenge ${challenge_txid} on claim ${claim_num}`);
		if (claim.expiry_ts < Date.now() / 1000) {
			notifications.notifyAdmin(`on new challenge: challenging period expired in claim ${claim_num}`, `too late: the challenging period in claim ${claim_num} challenged by ${challenge_txid} has already expired, will not attack\nbridge ${bridge_id} on ${network}, AA ${bridge_aa}`);
			return unlock();
		}
		const required_counterstake = BigNumber.from(claim.challenging_target).sub(claim.stakes[valid_outcome]);
		if (required_counterstake.lte(0))
			throw Error(`required counterstake is ${required_counterstake} after challenge ${challenge_txid} on claim ${claim_num}`)
		const counterstake = await getCounterstakeAmount(network, assistant_aa, required_counterstake, asset);
		if (counterstake.isZero()) {
			notifications.notifyAdmin(`0 balance available to counterstake claim ${claim_num} challenged in tx ${challenge_txid}`);
			return unlock(`0 balance available to counterstake claim ${claim_num} challenged in tx ${challenge_txid}`);
		}
		if (counterstake.lt(required_counterstake))
			notifications.notifyAdmin(`counterstaking ${counterstake} out of ${required_counterstake} to challenge ${challenge_txid} on claim ${claim_num}`);
		await sendChallenge(network, bridge_aa, assistant_aa, { claim_num, bridge_id, type }, valid_outcome, asset, counterstake);
	}
	unlock();
}


async function handleWithdrawal(bridge, type, claim_num, withdrawal_txid) {
	const { bridge_id, export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_asset, foreign_asset, stake_asset, home_symbol, home_network, foreign_network } = bridge;
	const network = type === 'expatriation' ? foreign_network : home_network;
	const unlock = await mutex.lock(network);
	const claim_info = { claim_num, bridge_id, type };

	const bridge_aa = type === 'expatriation' ? import_aa : export_aa;
	if (!bridge_aa)
		throw Error(`null aa in withdrawal ${withdrawal_txid} on claim ${claim_num}`);
	const desc = `claim ${claim_num} on ${network} bridge ${bridge_id} AA ${bridge_aa} for ${home_symbol}`;
	console.log(`handling withdrawal tx ${withdrawal_txid} from ${desc}`);
	let assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;
	const api = networkApi[network];
	const valid_outcome = await getValidOutcome({ claim_num, bridge_id, type }, false);
	if (valid_outcome === null) {
		if (!bCatchingUpOrHandlingPostponedEvents)
			throw Error(`withdrawn ${desc} not found`);
		setTimeout(() => {
			console.log(`retrying withdrawal ${withdrawal_txid}`);
			handleWithdrawal(bridge, type, claim_num, withdrawal_txid);
		}, 3 * 60 * 1000);
		return unlock(`withdrawn ${desc} not found while catching up, will retry later`);
	}
	const claim = await api.getClaim(bridge_aa, claim_num, true, true);
	if (claim.current_outcome === valid_outcome) {
		console.log(`${desc} finished as expected`);
		if (!isZero(claim.stakes.no)) { // it was challenged
			if (assistant_aa && api.isMyAddress(claim.claimant_address)) // claimed myself
				assistant_aa = undefined;
			if (network !== 'Obyte')
				await wait(3000); // getMyStake() might go to a different node that is not perfectly synced
			const my_stake = await api.getMyStake(bridge_aa, claim_num, valid_outcome);
			const my_assistant_stake = assistant_aa ? await api.getMyStake(bridge_aa, claim_num, valid_outcome, assistant_aa) : 0;
			console.log(`my stake on ${desc} was ${my_stake} as myself aand ${my_assistant_stake} as assistant`); // duplicates are harmless
			if (!isZero(my_stake) || !isZero(my_assistant_stake)) {
				console.log(`will withdraw from ${desc}`);
				await sendWithdrawalRequest(network, bridge_aa, claim_info, assistant_aa);
			}
			else
				await finishClaim(claim_info);
		}
		else
			await finishClaim(claim_info);
	}
	else {
		notifications.notifyAdmin(`${desc} finished as "${claim.current_outcome}" in ${withdrawal_txid}, expected "${valid_outcome}"`, JSON.stringify(claim, null, 2));
		await finishClaim(claim_info);
		eventBus.emit('finished_as_fraud', bridge, type, claim_num, withdrawal_txid, claim, valid_outcome);
	}
	unlock();
}

function isZero(amount) {
	return amount === 0 || BigNumber.isBigNumber(amount) && amount.isZero();
}

function amountsMatch(src_amount, src_asset_decimals, dst_amount, dst_asset_decimals) {
	src_amount = BigNumber.from(src_amount);
	dst_amount = BigNumber.from(dst_amount);
	const factor = BigNumber.from(10).pow(Math.abs(src_asset_decimals - dst_asset_decimals));
	return (
		src_asset_decimals > dst_asset_decimals && dst_amount.mul(factor).eq(src_amount)
		||
		src_asset_decimals <= dst_asset_decimals && src_amount.mul(factor).eq(dst_amount)
	);
}

function getDestAmount(src_amount, src_asset_decimals, dst_asset_decimals) {
	src_amount = BigNumber.from(src_amount);
	const factor = BigNumber.from(10).pow(Math.abs(src_asset_decimals - dst_asset_decimals));
	return src_asset_decimals > dst_asset_decimals ? src_amount.div(factor) : src_amount.mul(factor);
}

async function getCounterstakeAmount(network, assistant_aa, required_counterstake, asset) {
	const api = networkApi[network];
	let balance = BigNumber.from(0);
	if (assistant_aa)
		balance = BigNumber.from(await api.getBalance(assistant_aa, asset));
	// assistant might have penny balance like a few thousand bytes left over from its initialization
	const bAssistantHasEnoughBalance = required_counterstake.lte(balance);
	const bFromAssistant = assistant_aa && bAssistantHasEnoughBalance;
	if (!bAssistantHasEnoughBalance) // use own balance if assistant's balance is not sufficient for a full counterstake
		balance = BigNumber.from(await api.getMyBalance(asset));
	console.log(`${bFromAssistant ? 'assistant' : 'my'} balance available for counterstaking: ${balance}`);
	const fBalance = parseFloat(utils.formatEther(balance));
	const max_stake = utils.parseEther((conf.max_exposure * fBalance).toFixed(18));
	return required_counterstake.lt(max_stake) ? required_counterstake : max_stake;
}


async function getValidOutcome({ claim_num, bridge_id, type }, bThrowIfNotFound) {
	const [db_claim] = await db.query("SELECT * FROM claims WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge_id, type]);
	if (!db_claim) {
		if (bThrowIfNotFound)
			throw Error(`claim ${claim_num} not found in db`);
		return null;
	}
	return db_claim.transfer_id ? 'yes' : 'no';
}

async function getMyStake({ claim_num, bridge_id, type }) {
	const [row] = await db.query("SELECT my_stake FROM claims WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge_id, type]);
	return row ? row.my_stake : null;
}

async function sendChallenge(network, bridge_aa, assistant_aa, { claim_num, bridge_id, type }, stake_on, asset, counterstake) {
	const api = networkApi[network];
	let bClaimFromPooledAssistant = !!assistant_aa;
	if (bClaimFromPooledAssistant) {
		const bAssistantHasEnoughBalance = counterstake.lte(await api.getBalance(assistant_aa, asset));
		if (bAssistantHasEnoughBalance)
			console.log(`will challenge claim ${claim_num} with ${stake_on} from assistant AA ${assistant_aa}`);
		else {
			console.log(`assistant AA ${assistant_aa} has insufficient balance to challenge claim ${claim_num} with ${stake_on}, will try to challenge myself`);
			bClaimFromPooledAssistant = false;
		}
	}
	const txid = bClaimFromPooledAssistant
		? await api.sendChallengeFromPooledAssistant(assistant_aa, claim_num, stake_on, counterstake)
		: await api.sendChallenge(bridge_aa, claim_num, stake_on, asset, counterstake);
	if (txid) {
		const my_stake = await getMyStake({ claim_num, bridge_id, type });
		const new_my_stake = BigNumber.from(my_stake).add(counterstake);
		await db.query("UPDATE claims SET my_stake=? WHERE claim_num=? AND bridge_id=? AND type=?", [new_my_stake.toString(), claim_num, bridge_id, type]);
		const [{ claim_txid }] = await db.query("SELECT claim_txid FROM claims WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge_id, type]);
		notifications.notifyAdmin(`challenged claim ${claim_num}`, `network ${network}, bridge ${bridge_id}, AA ${bridge_aa}\nclaim txid ${claim_txid}\n${counterstake.toString()} on ${stake_on}`);
		setTimeout(updateMaxAmounts, 60 * 1000);
	}
}

async function addressHasStakesInClaim({ claim_num, bridge_id, type }, address) {
	const rows = await db.query(
		`SELECT 1 FROM claims WHERE bridge_id=? AND claim_num=? AND type=? AND claimant_address=?
		UNION
		SELECT 1 FROM challenges WHERE bridge_id=? AND claim_num=? AND type=? AND address=?`,
		[bridge_id, claim_num, type, address, bridge_id, claim_num, type, address]
	);
	return rows.length > 0;
}

async function sendWithdrawalRequest(network, bridge_aa, { claim_num, bridge_id, type }, assistant_aa) {
	const key = `${claim_num}-${bridge_id}-${type}`;
	if (unconfirmeWithdrawals[key]) {
		console.log(`already withdrawing ${key} in ${unconfirmeWithdrawals[key]}`);
		return null;
	}
	const api = networkApi[network];
	let txid;
	if (!assistant_aa)
		txid = await api.sendWithdrawalRequest(bridge_aa, claim_num);
	else {
		// we might send withdrawal requests for both self and assistant
		if (await addressHasStakesInClaim({ claim_num, bridge_id, type }, assistant_aa)) {
			console.log(`sending withdrawal request on claim ${claim_num} for assistant`);
			txid = await api.sendWithdrawalRequest(bridge_aa, claim_num, assistant_aa);
			if (!txid)
				return null;
		}
		const my_address = api.getMyAddress();
		if (await addressHasStakesInClaim({ claim_num, bridge_id, type }, my_address)) {
			console.log(`sending withdrawal request on claim ${claim_num} for myself`);
			txid = await api.sendWithdrawalRequest(bridge_aa, claim_num);
			if (!txid)
				return null;
		}
	}
	if (txid) {
		unconfirmeWithdrawals[key] = txid;
		process.nextTick(async () => {
			const status = await api.waitForTransaction(txid);
			setTimeout(() => { delete unconfirmeWithdrawals[key]; }, 15 * 60 * 1000); // even if failed
			if (status) { // only if successful
				await finishClaim({ claim_num, bridge_id, type });
				setTimeout(updateMaxAmounts, 60 * 1000);
				setTimeout(recheckOldTransfers, 15 * 60 * 1000);
			}
		});
	}
	return txid;
}

async function finishClaim({ claim_num, bridge_id, type }) {
	await db.query("UPDATE claims SET is_finished=1 WHERE claim_num=? AND bridge_id=? AND type=?", [claim_num, bridge_id, type]);
}


async function checkUnfinishedClaims() {
	console.log('checking for unfinished claims');
	const rows = await db.query(`SELECT export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_network, foreign_network, claim_num, bridge_id, type, home_symbol, claims.creation_date FROM claims CROSS JOIN bridges USING(bridge_id) WHERE is_finished=0 AND my_stake!='0' AND claims.creation_date < ${db.addTime(process.env.testnet || process.env.devnet ? '-1 MINUTE' : '-3 DAY')}`);
	console.log(`${rows.length} unfinished claims`);
	for (let { export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_network, foreign_network, home_symbol, claim_num, bridge_id, type, creation_date } of rows) {
		const claim_info = { claim_num, bridge_id, type };
		const bridge_aa = type === 'expatriation' ? import_aa : export_aa;
		if (!bridge_aa)
			throw Error(`null aa in stored claim ${claim_num}`);
		let assistant_aa = type === 'expatriation' ? import_assistant_aa : export_assistant_aa;
		const network = type === 'expatriation' ? foreign_network : home_network;
		const api = networkApi[network];
		if (!api)
			continue;
		const desc = `claim ${claim_num} of ${creation_date} on ${network} bridge ${bridge_id} AA ${bridge_aa} for ${home_symbol}`;
		console.log(`checkUnfinishedClaims: will query ${desc}`);
		let claim;
		try {
			claim = await api.getClaim(bridge_aa, claim_num, false, false);
			if (!claim)
				claim = await api.getClaim(bridge_aa, claim_num, true, false);
		}
		catch (e) {
			console.log(`checkUnfinishedClaims: getting status of ${desc} failed`, e);
			continue;
		}
		if (!claim)
			throw Error(`${desc} not found in ongoing nor finished`);
		if (assistant_aa && api.isMyAddress(claim.claimant_address)) // claimed myself
			assistant_aa = undefined;
		if (claim.expiry_ts < Date.now() / 1000 - 60) {
			const valid_outcome = await getValidOutcome(claim_info, true);
			if (claim.current_outcome === valid_outcome) {
				console.log(`checkUnfinishedClaims: ${desc} finished as expected`);
				const my_stake = await api.getMyStake(bridge_aa, claim_num, valid_outcome);
				const my_assistant_stake = assistant_aa ? await api.getMyStake(bridge_aa, claim_num, valid_outcome, assistant_aa) : 0;
				console.log(`my stake on ${desc} was ${my_stake} as myself and ${my_assistant_stake} as assistant`);
				if (isZero(my_stake) && isZero(my_assistant_stake))
					await finishClaim(claim_info);
				else {
					console.log(`checkUnfinishedClaims: will withdraw from ${desc}`);
					await sendWithdrawalRequest(network, bridge_aa, claim_info, assistant_aa);
				}
			}
			else {
				notifications.notifyAdmin(`checkUnfinishedClaims: ${desc} finished as "${claim.current_outcome}", expected "${valid_outcome}"`, JSON.stringify(claim, null, 2));
				await finishClaim(claim_info);
				const bridge = { export_aa, import_aa, export_assistant_aa, import_assistant_aa, home_network, foreign_network, bridge_id, home_symbol };
				eventBus.emit('finished_as_fraud', bridge, type, claim_num, null, claim, valid_outcome);
			}
		}
		else
			console.log(`checkUnfinishedClaims: ${desc} challenging period is still ongoing`);
	}
	console.log('done unfinished claims');
}

async function recheckOldTransfers() {
	if (!conf.bClaimForOthers)
		return;
	let unlock = await mutex.lock('recheckOldTransfers');
	const transfers = await db.query(
		`SELECT transfers.* FROM transfers LEFT JOIN claims USING(transfer_id)
		WHERE claim_num IS NULL AND is_confirmed=1 AND is_bad=0 AND transfers.reward>=0
			AND transfers.creation_date < ${db.addTime('-1 MINUTE')}
			${process.env.testnet ? `AND transfers.creation_date > ${db.addTime('-30 DAY')}` : ''}
		ORDER BY transfer_id`
	);
	console.error('----- transfers', transfers.length)
	if (transfers.length === 0)
		return unlock();
	setTimeout(() => { // might get stuck in case of reconnect, release the lock anyway
		if (unlock)
			unlock();
		unlock = null;
	}, 1800 * 1000);
	for (let transfer of transfers) {
		console.log('will retry old unhandled transfer', transfer);
		await handleTransfer(transfer);
	}
	if (unlock)
		unlock();
	unlock = null;
}

function forgetOldUnconfirmedClaims() {
	for (let transfer_id in unconfirmedClaims) {
		const { claim_txid, ts } = unconfirmedClaims[transfer_id];
		if (Date.now() > ts + 4 * 3600 * 1000) {
			console.log(`forgetting unconfirmed claim ${claim_txid} in transfer ${transfer_id} due to timeout`);
			delete unconfirmedClaims[transfer_id];
		}
	}
}

function forgetUnconfirmedClaim(claim_txid) {
	for (let transfer_id in unconfirmedClaims) {
		const claim = unconfirmedClaims[transfer_id];
		if (claim.claim_txid === claim_txid) {
			console.log(`forgetting unconfirmed claim ${claim_txid} in transfer ${transfer_id} as the claim bounced`);
			delete unconfirmedClaims[transfer_id];
			return;
		}
	}
	console.log(`bounced tx ${claim_txid} not found among unconfirmed claims`);
}


async function handleNewExportAA(export_aa, home_network, home_asset, home_asset_decimals, foreign_network, foreign_asset, version) {
	const unlock = await mutex.lock('new_bridge');
	console.log('new export', { export_aa, home_network, home_asset, home_asset_decimals, foreign_network, foreign_asset, version });
	const [existing_bridge] = await db.query("SELECT bridge_id FROM bridges WHERE export_aa=?", [export_aa]);
	if (existing_bridge)
		return unlock(`export AA ${export_aa} already belongs to bridge ${existing_bridge.bridge_id}`);
//	if (!networkApi[home_network])
//		return unlock(`skipping export AA ${export_aa} because home network ${home_network} is disabled or unknown`);
//	if (!networkApi[foreign_network])
//		return unlock(`skipping export AA ${export_aa} because foreign network ${foreign_network} is disabled or unknown`);

	if (networkApi[foreign_network] && !networkApi[foreign_network].isValidNonnativeAsset(foreign_asset))
		return unlock(`invalid foreign asset ${foreign_asset}`);
	
	const home_symbol = await networkApi[home_network].getSymbol(home_asset);
	const foreign_symbol = networkApi[foreign_network] ? await networkApi[foreign_network].getSymbol(foreign_asset) : null;
	
	// look for an incomplete bridge with the matching import end
	const [bridge] = await db.query(`SELECT * FROM bridges WHERE foreign_asset=?`, [foreign_asset]);
	if (bridge) { // export end is already known
		const { bridge_id, import_aa } = bridge;
		if (bridge.export_aa) {
			notifications.notifyAdmin(`duplicate export AA`, `foreign asset ${foreign_asset} is already connected to another export AA ${bridge.export_aa} on bridge ${bridge_id}`);
			return unlock(`foreign asset ${foreign_asset} is already connected to another export AA ${bridge.export_aa} on bridge ${bridge_id}`);
		}
		if (bridge.home_network !== home_network)
			return unlock(`home network mismatch: existing half-bridge ${bridge_id}: ${bridge.home_network}, new export: ${home_network}`);
		if (bridge.home_asset !== home_asset)
			return unlock(`home asset mismatch: existing half-bridge ${bridge_id}: ${bridge.home_asset}, new export: ${home_asset}`);
		if (bridge.foreign_network !== foreign_network)
			return unlock(`foreign network mismatch: existing half-bridge ${bridge_id}: ${bridge.foreign_network}, new export: ${foreign_network}`);
		const [claim] = await db.query(`SELECT * FROM claims WHERE bridge_id=? AND transfer_id IS NULL LIMIT 1`);
		if (claim)
			return unlock(`already had at least one invalid claim ${claim.claim_num} on half-complete import-only bridge ${bridge_id}, will not complete the bridge`);
		await db.query(`UPDATE bridges SET export_aa=?, home_asset_decimals=?, home_symbol=?, foreign_symbol=?, e_v=? WHERE bridge_id=?`, [export_aa, home_asset_decimals, home_symbol, foreign_symbol, version, bridge_id]);
		unlock(`completed bridge ${bridge_id} ${home_symbol} ${home_network}->${foreign_network} by adding export AA ${export_aa}`);
		if (networkApi[foreign_network])
			networkApi[foreign_network].startWatchingImportAA(import_aa);
		networkApi[home_network].startWatchingExportAA(export_aa);
		return true;
	}
	const params = [export_aa, home_network, home_asset, home_asset_decimals, home_symbol, foreign_network, foreign_asset, foreign_symbol, version, '', '', ''];
	await db.query(`INSERT INTO bridges (export_aa, home_network, home_asset, home_asset_decimals, home_symbol, foreign_network, foreign_asset, foreign_symbol, e_v, i_v, ea_v, ia_v) VALUES (${Array(params.length).fill('?').join(', ')})`, params);
	unlock(`created a new half-bridge ${export_aa} ${home_symbol} ${home_network}->${foreign_network} with only export end`);
	return true;
}


async function handleNewImportAA(import_aa, home_network, home_asset, foreign_network, foreign_asset, foreign_asset_decimals, stake_asset, version) {
	const unlock = await mutex.lock('new_bridge');
	console.log('new import', { import_aa, home_network, home_asset, foreign_network, foreign_asset, foreign_asset_decimals, stake_asset, version });
	const [existing_bridge] = await db.query("SELECT bridge_id FROM bridges WHERE import_aa=?", [import_aa]);
	if (existing_bridge)
		return unlock(`import AA ${import_aa} already belongs to bridge ${existing_bridge.bridge_id}`);
//	if (!networkApi[home_network])
//		return unlock(`skipping import AA ${import_aa} because home network ${home_network} is disabled or unknown`);
//	if (!networkApi[foreign_network])
//		return unlock(`skipping import AA ${import_aa} because foreign network ${foreign_network} is disabled or unknown`);

	const home_symbol = networkApi[home_network] ? await networkApi[home_network].getSymbol(home_asset) : null;
	const foreign_symbol = await networkApi[foreign_network].getSymbol(foreign_asset);
	
	// look for an incomplete bridge with the matching export end
	const [bridge] = await db.query(`SELECT * FROM bridges WHERE foreign_asset=?`, [foreign_asset]);
	if (bridge) { // export end is already known
		const { bridge_id, export_aa } = bridge;
		if (bridge.import_aa)
			throw Error(`foreign asset ${foreign_asset} is already connected to another import AA ${bridge.import_aa} on bridge ${bridge_id}`);
		if (bridge.home_network !== home_network)
			return unlock(`home network mismatch: existing half-bridge ${bridge_id}: ${bridge.home_network}, new import: ${home_network}`);
		if (bridge.home_asset !== home_asset)
			return unlock(`home asset mismatch: existing half-bridge ${bridge_id}: ${bridge.home_asset}, new import: ${home_asset}`);
		if (bridge.foreign_network !== foreign_network)
			return unlock(`foreign network mismatch: existing half-bridge ${bridge_id}: ${bridge.foreign_network}, new import: ${foreign_network}`);
		const [claim] = await db.query(`SELECT * FROM claims WHERE bridge_id=? AND transfer_id IS NULL LIMIT 1`);
		if (claim)
			return unlock(`already had at least one invalid claim ${claim.claim_num} on half-complete export-only bridge ${bridge_id}, will not complete the bridge`);
		await db.query(`UPDATE bridges SET import_aa=?, foreign_asset_decimals=?, stake_asset=?, home_symbol=?, foreign_symbol=?, i_v=? WHERE bridge_id=?`, [import_aa, foreign_asset_decimals, stake_asset, home_symbol, foreign_symbol, version, bridge_id]);
		unlock(`completed bridge ${bridge_id} ${import_aa} ${foreign_symbol} ${home_network}->${foreign_network} by adding import AA ${import_aa}`);
		networkApi[foreign_network].startWatchingImportAA(import_aa);
		if (networkApi[home_network])
			networkApi[home_network].startWatchingExportAA(export_aa);
		return true;
	}
	const params = [import_aa, home_network, home_asset, home_symbol, foreign_network, foreign_asset, foreign_asset_decimals, foreign_symbol, stake_asset, '', version, '', ''];
	await db.query(`INSERT INTO bridges (import_aa, home_network, home_asset, home_symbol, foreign_network, foreign_asset, foreign_asset_decimals, foreign_symbol, stake_asset, e_v, i_v, ea_v, ia_v) VALUES (${Array(params.length).fill('?').join(', ')})`, params);
	unlock(`created a new half-bridge ${import_aa} ${foreign_symbol} ${home_network}->${foreign_network} with only import end`);
	return true;
}

async function handleNewAssistantAA(side, assistant_aa, bridge_aa, network, manager, assistant_shares_asset, assistant_shares_symbol, version) {
	const unlock = await mutex.lock('new_bridge');
	console.log(`new assistant`, { side, assistant_aa, bridge_aa, manager, assistant_shares_asset, assistant_shares_symbol, version });
	const [bridge] = await db.query(`SELECT * FROM bridges WHERE ${side}_aa=? AND ${side === 'export' ? 'home_network' : 'foreign_network'}=?`, [bridge_aa, network]);
	if (!bridge)
		return unlock(`got new ${side} assistant for AA ${bridge_aa} but the bridge not found`);
	const { bridge_id } = bridge;
	const meIsManager = networkApi[network].getMyAddress() === manager;
	if (meIsManager)
		await db.query(`UPDATE bridges SET ${side}_assistant_aa=?, ${side === 'export' ? 'ea_v' : 'ia_v'}=? WHERE bridge_id=?`, [assistant_aa, version, bridge_id]);
	await db.query(`INSERT ${db.getIgnore()} INTO pooled_assistants (assistant_aa, bridge_id, bridge_aa, network, side, manager, shares_asset, shares_symbol, \`version\`) VALUES(?, ?,?, ?,?,?, ?,?, ?)`, [assistant_aa, bridge_id, bridge_aa, network, side, manager, assistant_shares_asset, assistant_shares_symbol, version]);
	unlock();
	return meIsManager;
}

async function populatePooledAssistantsTable() {
	const dag = require('aabot/dag.js');

	async function addPooledAssistant(bridge_id, network, bridge_aa, side, assistant_aa) {
		const api = networkApi[network];
		let shares_asset, manager;
		if (network === 'Obyte') {
			manager = (await dag.readAAParams(assistant_aa)).manager;
			shares_asset = await dag.readAAStateVar(assistant_aa, 'shares_asset');
		}
		else {
			manager = api.getMyAddress();
			shares_asset = assistant_aa;
		}
		const shares_symbol = await api.getSymbol(shares_asset);
		await db.query(`INSERT INTO pooled_assistants (assistant_aa, bridge_id, bridge_aa, network, side, manager, shares_asset, shares_symbol) VALUES(?, ?,?, ?,?,?, ?,?)`, [assistant_aa, bridge_id, bridge_aa, network, side, manager, shares_asset, shares_symbol]);
	}

	const bridges = await db.query("SELECT * FROM bridges");
	for (let { bridge_id, export_aa, export_assistant_aa, import_aa, import_assistant_aa, home_network, foreign_network } of bridges) {
		if (export_assistant_aa)
			await addPooledAssistant(bridge_id, home_network, export_aa, 'export', export_assistant_aa);
		if (import_assistant_aa)
			await addPooledAssistant(bridge_id, foreign_network, import_aa, 'import', import_assistant_aa);
	}
}

async function getActiveClaimants() {
	const claimant_rows = await db.query(`SELECT DISTINCT claimant_address FROM claims WHERE claimant_address != dest_address AND creation_date > ` + db.addTime('-30 DAY'));
	let claimants = claimant_rows.map(row => row.claimant_address);
	const manager_rows = await db.query(`SELECT DISTINCT manager FROM pooled_assistants WHERE assistant_aa IN(${claimants.map(db.escape).join(', ')})`);
	const managers = manager_rows.map(row => row.manager);
	for (let manager of managers)
		if (!claimants.includes(manager))
			claimants.push(manager);
	return claimants;
}

async function updateMaxAmounts() {
	if (!conf.webPort)
		return console.log('updateMaxAmounts skipped as there is no web server');
	const unlock = await mutex.lockOrSkip('updateMaxAmounts');
	if (!unlock)
		return console.log('updateMaxAmounts already under way, skipping');
	console.log('starting updateMaxAmounts');

	// get active claimants first
	const claimants = await getActiveClaimants();
	console.log('active claimants', claimants);
	if (claimants.length === 0) {
		maxAmounts = {};
		return unlock('updateMaxAmounts done, no active claimants');
	}

	const timeout = setTimeout(() => {
		unlock(`updateMaxAmounts is taking too long, aborting`);
	}, 1800 * 1000);

	let _maxAmounts = {};
/*	const claims = await db.query(
		`SELECT DISTINCT bridge_id, type, claimant_address, import_aa, stake_asset, home_asset, foreign_asset, home_asset_decimals, foreign_asset_decimals, home_network, foreign_network 
		FROM claims
		CROSS JOIN bridges USING(bridge_id)
		WHERE claimant_address IN(${claimants.map(db.escape).join(', ')})`);*/
	const bridges = await db.query("SELECT * FROM bridges WHERE import_aa IS NOT NULL AND export_aa IS NOT NULL");
	for (let { bridge_id, import_aa, stake_asset, home_asset, foreign_asset, home_asset_decimals, foreign_asset_decimals, home_network, foreign_network } of bridges) {
		if (!networkApi[home_network] || !networkApi[foreign_network]) {
			console.log(`updateMaxAmounts: skipping bridge ${bridge_id} ${home_network}->${foreign_network} as one of networks is not available`);
			continue;
		}
		for (let claimant_address of claimants) {
			if (networkApi[home_network] && networkApi[home_network].isValidAddress(claimant_address)) {
				const type = 'repatriation';
				const key = bridge_id + type;
				try {
					let balance = await networkApi[home_network].getBalance(claimant_address, home_asset, true);
					balance = balance.toString() / 10 ** home_asset_decimals * 0.98; // pool manager's fees are unavailable
					const max_amount = balance / 2; // amount + stake
					if (!_maxAmounts[key] || max_amount > _maxAmounts[key])
						_maxAmounts[key] = max_amount;
				}
				catch (e) {
					console.log(`updateMaxAmounts repatriation ${home_network} error`, e);
					_maxAmounts[key] = maxAmounts && maxAmounts[key] ? maxAmounts[key] : 0;
				}
			}
			if (networkApi[foreign_network] && networkApi[foreign_network].isValidAddress(claimant_address)) {
				const type = 'expatriation';
				const key = bridge_id + type;
				try {
					let balance = await networkApi[foreign_network].getBalance(claimant_address, foreign_asset, true);
					balance = BigNumber.from(balance);
					if (balance.isZero())
						continue;
					let stake_balance = await networkApi[foreign_network].getBalance(claimant_address, stake_asset, true);
					stake_balance = BigNumber.from(stake_balance);
					if (stake_balance.isZero())
						continue;
					let required_stake = await networkApi[foreign_network].getRequiredStake(import_aa, balance);
					required_stake = BigNumber.from(required_stake).mul(foreign_network === 'Obyte' ? 110 : 100).div(100); // add 10% for price volatility
					let max_amount = balance.toString() / 10 ** foreign_asset_decimals * 0.98;
					if (required_stake.gt(stake_balance))
						max_amount *= stake_balance.toString() / required_stake.toString(); // scale down
					if (!_maxAmounts[key] || max_amount > _maxAmounts[key])
						_maxAmounts[key] = max_amount;
				}
				catch (e) {
					console.log(`updateMaxAmounts expatriation ${foreign_network} bridge ${bridge_id} error`, e);
					_maxAmounts[key] = maxAmounts && maxAmounts[key] ? maxAmounts[key] : 0;
				}
			}
		}
	}

	clearTimeout(timeout);
	maxAmounts = _maxAmounts;
	console.log('done updateMaxAmounts', maxAmounts);
	unlock();
}

function getMaxAmounts() {
	if (!maxAmounts)
		throw Error(`no maxAmounts yet`);
	return maxAmounts;
}

async function restartNetwork(network) {
	console.log(`restarting ${network}`);
	const bridges = await db.query("SELECT * FROM bridges WHERE home_network=? OR foreign_network=?", [network, network]);
	for (let bridge of bridges) {
		const { bridge_id, home_network, export_aa, export_assistant_aa, foreign_network, import_aa, import_assistant_aa } = bridge;
		if (export_aa && home_network === network)
			networkApi[home_network].startWatchingExportAA(export_aa);
		if (import_aa && foreign_network === network)
			networkApi[foreign_network].startWatchingImportAA(import_aa);
		if (export_assistant_aa && home_network === network)
			networkApi[home_network].startWatchingExportAssistantAA(export_assistant_aa);
		if (import_assistant_aa && foreign_network === network)
			networkApi[foreign_network].startWatchingImportAssistantAA(import_assistant_aa);
	}
	await networkApi[network].startWatchingSymbolUpdates();
	await networkApi[network].startWatchingFactories();
	await networkApi[network].startWatchingAssistantFactories();
	await networkApi[network].catchup();
	console.log(`restart: catching up ${network} done`);
}

async function start() {
	networkApi.Obyte = new Obyte();
	if (!process.env.testnet)
		networkApi.Ethereum = new Ethereum();
	if (!conf.disableBSC)
		networkApi.BSC = new BSC();
	if (!conf.disablePolygon)
		networkApi.Polygon = new Polygon();
	if (!conf.disableKava)
		networkApi.Kava = new Kava();

	let caughtUp = {};
	let disconnected_ts = {};

	setInterval(() => {
		console.log('disconnected networks', disconnected_ts);
		for (let network in disconnected_ts) {
			const elapsed = Date.now() - disconnected_ts[network];
			if (elapsed > 3600_000)
				notifications.notifyAdmin(`${network} disconnected for too long`, `${network} disconnected for ${elapsed / 1000}s`);
		}
	}, 3600_000)

	// reconnect to Ethereum websocket
	eventBus.on('network_disconnected', async (network) => {
		if (!caughtUp[network])
			throw Error(`${network} disconnected before having caught up`);
		console.log('will reconnect to', network);
		if (!disconnected_ts[network])
			disconnected_ts[network] = Date.now();
		if (network === 'Ethereum')
			networkApi.Ethereum = new Ethereum();
		else if (network === 'BSC')
			networkApi.BSC = new BSC();
		else if (network === 'Polygon')
			networkApi.Polygon = new Polygon();
		else if (network === 'Kava')
			networkApi.Kava = new Kava();
		else
			throw Error(`unknown network disconnected ${network}`);
		await restartNetwork(network);
		delete disconnected_ts[network];
	});

	// some bridges might be incomplete: only import or only export
	const bridges = await db.query("SELECT * FROM bridges");
	for (let bridge of bridges) {
		const { bridge_id, home_network, export_aa, export_assistant_aa, foreign_network, import_aa, import_assistant_aa } = bridge;
		if (!networkApi[home_network] || !networkApi[foreign_network]) {
			console.log(`skipping bridge ${bridge_id} ${home_network}->${foreign_network} as one of networks is not available`);
			continue;
		}
		if (export_aa)
			networkApi[home_network].startWatchingExportAA(export_aa);
		if (import_aa)
			networkApi[foreign_network].startWatchingImportAA(import_aa);
		if (export_assistant_aa)
			networkApi[home_network].startWatchingExportAssistantAA(export_assistant_aa);
		if (import_assistant_aa)
			networkApi[foreign_network].startWatchingImportAssistantAA(import_assistant_aa);
	}

	let starters = [];
	for (let net in networkApi) {
		const f = async () => {
			console.log(`starting`, net);
			await networkApi[net].startWatchingSymbolUpdates();
			await networkApi[net].startWatchingFactories();
			await networkApi[net].startWatchingAssistantFactories();
			// called after adding watched addresses so that they are included in the first history request
			if (net === 'Obyte')
				network.start();
			console.log(`started`, net);
		};
		starters.push(f());
	}
	await Promise.all(starters);

//	await populatePooledAssistantsTable();

	// must be called after the bridges are loaded, contractsByAddress are populated by then
	let catchups = [];
	for (let net in networkApi) {
		const f = async () => {
			await networkApi[net].catchup();
			caughtUp[net] = true;
		};
		catchups.push(f());
	}
	await Promise.all(catchups);
	console.log('catching up done');
	bCatchingUp = false;
	setTimeout(() => { bCatchingUpOrHandlingPostponedEvents = false; }, 3 * 60 * 1000);

	await checkUnfinishedClaims();
	setInterval(checkUnfinishedClaims, (process.env.testnet || process.env.devnet ? 2 : 30) * 60 * 1000); // every half an hour

	setInterval(forgetOldUnconfirmedClaims, 3600 * 1000);
	
	setTimeout(recheckOldTransfers, 61 * 1000);
	setInterval(recheckOldTransfers, 3600 * 1000); // every hour, in case gas price was too high when the claim was received, and then it got lower

	if (conf.webPort) {
		try {
			await asyncCallWithTimeout(updateMaxAmounts(), 60 * 1000);
		}
		catch (e) {
			console.log('updateMaxAmounts failed', e);
		}
		setInterval(updateMaxAmounts, 3600 * 1000); // every hour
	}

	// we start Polygon with Infura to be able to scan more than 1000 blocks of past events, then switch to maticgivil to track ongoing events
/*	setTimeout(async () => {
		console.log('will restart Polygon on a free provider');
		networkApi.Polygon.forget();
		networkApi.Polygon = new Polygon(true);
		await restartNetwork('Polygon');
	}, 10 * 60 * 1000);*/
}

// don't rewrite module.exports, otherwise circular dependent modules won't see the new object
Object.assign(module.exports, {
	networkApi,
	getBridge,
	getBridgeByAddress,
	addTransfer,
	removeTransfer,
	handleNewClaim,
	handleChallenge,
	handleWithdrawal,
	handleNewExportAA,
	handleNewImportAA,
	handleNewAssistantAA,
	getActiveClaimants,
	getMaxAmounts,
	forgetUnconfirmedClaim,
	start,
});

