const mutex = require('ocore/mutex.js');
const { request } = require('./request.js');
const { wait } = require('./utils.js');

let last_req_ts = {};
const timeout = 6000; // 6 sec


async function waitBetweenRequests(base_url) {
	const passed = last_req_ts[base_url] ? Date.now() - last_req_ts[base_url] : Infinity;
	if (passed < timeout) {
		console.log(`will wait for ${timeout - passed} ms between ${base_url} requests`);
		await wait(timeout - passed);
	}
}

async function getAddressHistory({ base_url, address, startblock, startts, api_key }) {
	const unlock = await mutex.lock(base_url);
	await waitBetweenRequests(base_url);
	if (startts && !startblock) {
		let url = `${base_url}/api?module=block&action=getblocknobytime&timestamp=${startts}&closest=after`;
		if (api_key)
			url += `&apikey=${api_key}`;
		const resp = await request(url);
		startblock = resp.result;
		if (!startblock)
			throw Error(`no block number from ${base_url} for ${startts}: ${JSON.stringify(resp)}`);
		last_req_ts[base_url] = Date.now();
		await waitBetweenRequests(base_url);
	}
	let url = `${base_url}/api?module=account&action=txlist&address=${address}`;
	if (startblock)
		url += `&startblock=${startblock}`;
	if (api_key)
		url += `&apikey=${api_key}`;
	const resp = await request(url);
	const history = resp.result;
	if (!Array.isArray(history))
		throw Error(`no history from ${base_url} for ${address}: ${JSON.stringify(resp)}`);
	last_req_ts[base_url] = Date.now();
	unlock();
	return history;
}

async function getAddressBlocks({ base_url, address, startblock, startts, api_key }) {
	const history = await getAddressHistory({ base_url, address, startblock, startts, api_key });
	return history.map(tx => parseInt(tx.blockNumber));
}

async function test() {
	const blocks = await getAddressBlocks({ base_url: 'https://api.bscscan.com', address: '0x91C79A253481bAa22E7E481f6509E70e5E6A883F' });
	console.log(blocks);
	process.exit();
}
//test();

exports.getAddressBlocks = getAddressBlocks;
