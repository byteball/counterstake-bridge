/*jslint node: true */
"use strict";

const Koa = require('koa');
const KoaRouter = require('koa-router');
const cors = require('@koa/cors');
const bodyParser = require('koa-bodyparser');

const conf = require('ocore/conf.js');
const db = require('ocore/db.js');
const { networkApi, getActiveClaimants, getMaxAmounts } = require('./transfers.js');
const { ethers } = require("ethers");
const { mailerliteController } = require('./mailerlite.js');
const { fetchExchangeRateInUSD } = require('./prices.js');

const { constants: { AddressZero } } = ethers;

const app = new Koa();
const router = new KoaRouter();
app.use(bodyParser());


function setError(ctx, error) {
	ctx.body = {
		status: 'error',
		error: error.toString(),
	};
	console.error('ERROR:', error);
}

router.get('/bridges', async (ctx) => {

	const claimants = await getActiveClaimants();
	let claimantCounts = {};
	if (claimants.length > 0) {
		const claims = await db.query(`SELECT bridge_id, type, COUNT(DISTINCT claimant_address) AS c FROM claims WHERE claimant_address IN(${claimants.map(db.escape).join(', ')}) GROUP BY bridge_id, type`);
		for (let { bridge_id, type, c } of claims)
			claimantCounts[bridge_id + type] = c;
	}
	
	const maxAmounts = getMaxAmounts();
	
	const networks = Object.keys(networkApi);
	const bridges = await db.query("SELECT * FROM bridges WHERE import_aa IS NOT NULL AND export_aa IS NOT NULL AND home_network IN(?) AND foreign_network IN(?)", [networks, networks]);
	console.log(`-- getting bridges`);
	const start_ts = Date.now();
	const gas_networks = networks.filter(n => networkApi[n].getGasPrice);
	await Promise.all(gas_networks.map(n => networkApi[n].getGasPrice()));
	console.log('refreshed gas prices of', gas_networks);
	for (let bridge of bridges) {
		const { bridge_id, home_asset, foreign_asset, home_network, foreign_network } = bridge;
		bridge.min_expatriation_reward = await networkApi[foreign_network].getMinReward('expatriation', foreign_asset, home_network, home_asset, false, true);
		bridge.min_repatriation_reward = await networkApi[home_network].getMinReward('repatriation', home_asset, foreign_network, foreign_asset, false, true);
		bridge.count_expatriation_claimants = claimantCounts[bridge_id + 'expatriation'] || 0;
		bridge.count_repatriation_claimants = claimantCounts[bridge_id + 'repatriation'] || 0;
		bridge.max_expatriation_amount = maxAmounts[bridge_id + 'expatriation'] || 0;
		bridge.max_repatriation_amount = Math.max((maxAmounts[bridge_id + 'repatriation'] || 0) - (home_asset === AddressZero ? bridge.min_repatriation_reward : 0), 0);
	}
	console.log(`-- got bridges in ${Date.now() - start_ts}ms`);
	ctx.body = {
		status: 'success',
		data: bridges
	};
});

router.get('/pooled_assistants', async (ctx) => {
	const reqBridgesInfo = !!ctx.query.reqBridgesInfo;
	const reqUsdRates = !!ctx.query.reqUsdRates;

	let bridgesInfo = []; // We added the info suffix to avoid confusion with the bridge route.
	const responseData = {};

	const assistants = await db.query("SELECT pooled_assistants.*, MIN(claims.creation_date) AS first_claim_date FROM pooled_assistants LEFT JOIN claims ON assistant_aa=claimant_address GROUP BY assistant_aa");

	if (reqBridgesInfo || reqUsdRates) {
		bridgesInfo = await db.query("SELECT * FROM bridges");
	}
	
	if (reqBridgesInfo) responseData.bridges_info = bridgesInfo;

	if (reqUsdRates) {
		for (const assistant of assistants) {
			const bridge = bridgesInfo.find(bridge => bridge.bridge_id === assistant.bridge_id);

			if (!bridge) {
				console.error(`ERROR: Bridge not found for assistant ${assistant.assistant_aa}`);
				continue;
			};

			const { home_network, home_asset, foreign_network, stake_asset } = bridge;

			if (stake_asset) {
				assistant.stake_token_usd_rate = await fetchExchangeRateInUSD(foreign_network, stake_asset, true);
			}

			if (home_asset) {
				assistant.home_token_usd_rate = await fetchExchangeRateInUSD(home_network, home_asset, true);
			}
		}
	}

	responseData.assistants = assistants; // add assistants to the response data

	ctx.body = {
		status: 'success',
		data: responseData,
	};

	//	for (let assistant of assistants)
	//		if (assistant.creation_date && assistant.creation_date < assistant.first_claim_date)
	//			assistant.first_claim_date = assistant.creation_date;
});

router.get('/transfer/:txid*', async (ctx) => {
	const txid = ctx.params.txid ? decodeURIComponent(ctx.params.txid) : ctx.query.txid;
	const [transfer] = await db.query("SELECT * FROM transfers WHERE txid=? AND is_confirmed=1", [txid]);
	if (!transfer)
		return setError(ctx, 'no such transfer ' + txid);
	delete transfer.is_confirmed;
	const [claim] = await db.query("SELECT is_stable, unit, claim_txid, claim_num, claimant_address, is_finished FROM claims LEFT JOIN units ON claim_txid=unit WHERE transfer_id=?", [transfer.transfer_id]);
	if (claim) {
		transfer.status = (claim.is_stable || !claim.unit) ? 'claim_confirmed' : 'claimed';
		transfer.claim_txid = claim.claim_txid;
		transfer.is_finished = claim.is_finished;
		transfer.claim_num = claim.claim_num;
		transfer.claimant_address = claim.claimant_address;
	}
	else {
		if (txid.length === 44) { // Obyte
			const [unit] = await db.query("SELECT is_stable FROM units WHERE unit=?", [txid]);
			transfer.status = (unit && unit.is_stable) ? 'confirmed' : 'sent';
		}
		else // EVM
			transfer.status = 'mined';
	}
	ctx.body = {
		status: 'success',
		data: transfer
	};
});

router.get('/transfers/:address*', async (ctx) => {
	const address = ctx.params.address ? decodeURIComponent(ctx.params.address) : ctx.query.address;
	const all = !!ctx.query.all;
	const transfers = await db.query(`SELECT transfers.*, claim_txid, claim_num, claimant_address, is_finished, transfer_units.is_stable AS transfer_is_stable, claim_units.is_stable AS claim_is_stable
		FROM transfers
		LEFT JOIN claims USING(transfer_id)
		LEFT JOIN units AS transfer_units ON transfers.txid=transfer_units.unit
		LEFT JOIN units AS claim_units ON claim_txid=claim_units.unit
		WHERE (transfers.sender_address=? OR transfers.dest_address=?)
			AND is_confirmed=1 ${all ? '' : 'AND (is_finished=0 OR is_finished IS NULL)'}`,
		[address, address]
	);
	for (let transfer of transfers) {
		delete transfer.is_confirmed;
		if (transfer.claim_txid)
			transfer.status = transfer.claim_is_stable === 0 ? 'claimed' : 'claim_confirmed';
		else
			transfer.status = transfer.transfer_is_stable === 1 ? 'confirmed' : (transfer.transfer_is_stable === 0 ? 'sent' : 'mined');
	}
	ctx.body = {
		status: 'success',
		data: transfers
	};
});

if (conf.mailerlite_api_key) {
	router.post('/subscribe', mailerliteController);
}

app.use(cors());
app.use(router.routes());

function start() {
	if (conf.webPort)
		console.error(`Starting web server on port ${conf.webPort}`);
		app.listen(conf.webPort);
}

exports.start = start;
