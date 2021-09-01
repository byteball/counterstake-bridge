/*jslint node: true */
"use strict";

const Koa = require('koa');
const KoaRouter = require('koa-router');
const cors = require('@koa/cors');
const bodyParser = require('koa-bodyparser');

const conf = require('ocore/conf.js');
const db = require('ocore/db.js');
const { networkApi, getActiveClaimants, getMaxAmounts } = require('./transfers.js');

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
	for (let bridge of bridges) {
		const { bridge_id, home_asset, foreign_asset, home_network, foreign_network } = bridge;
		bridge.min_expatriation_reward = await networkApi[foreign_network].getMinReward('expatriation', foreign_asset, home_network, home_asset, false, true);
		bridge.min_repatriation_reward = await networkApi[home_network].getMinReward('repatriation', home_asset, foreign_network, foreign_asset, false, true);
		bridge.count_expatriation_claimants = claimantCounts[bridge_id + 'expatriation'] || 0;
		bridge.count_repatriation_claimants = claimantCounts[bridge_id + 'repatriation'] || 0;
		bridge.max_expatriation_amount = maxAmounts[bridge_id + 'expatriation'] || 0;
		bridge.max_repatriation_amount = maxAmounts[bridge_id + 'repatriation'] || 0;
	}
	console.log(`-- got bridges`);
	ctx.body = {
		status: 'success',
		data: bridges
	};
});

router.get('/pooled_assistants', async (ctx) => {
	const assistants = await db.query("SELECT * FROM pooled_assistants");
	ctx.body = {
		status: 'success',
		data: assistants
	};
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

app.use(cors());
app.use(router.routes());

function start() {
	if (conf.webPort)
		app.listen(conf.webPort);
}

exports.start = start;
