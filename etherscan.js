const { request } = require('./request.js');
const { wait } = require('./utils.js');

let last_req_ts = {};
const timeout = 6000; // 6 sec


async function getAddressHistory(base_url, address, startblock, api_key) {
	const passed = last_req_ts[base_url] ? Date.now() - last_req_ts[base_url] : Infinity;
	if (passed < timeout) {
		console.log(`will wait for ${timeout - passed} ms between ${base_url} requests`);
		await wait(timeout - passed);
	}
	let url = `${base_url}/api?module=account&action=txlist&address=${address}`;
	if (startblock)
		url += `&startblock=${startblock}`;
	if (api_key)
		url += `&apikey=${api_key}`;
	const resp = await request(url);
	if (resp.status !== "1")
		throw Error(`resp from ${base_url} for ${address}: ${JSON.stringify(resp)}`);
	const history = resp.result;
	if (!Array.isArray(history))
		throw Error(`no history from ${base_url} for ${address}: ${JSON.stringify(resp)}`);
	last_req_ts[base_url] = Date.now();
	return history;
}

async function getAddressBlocks(base_url, address, startblock, api_key) {
	const history = await getAddressHistory(base_url, address, startblock, api_key);
	return history.map(tx => tx.blockNumber);
}

async function test() {
	const blocks = await getAddressBlocks('https://api.bscscan.com', '0x91C79A253481bAa22E7E481f6509E70e5E6A883F');
	console.log(blocks);
	process.exit();
}
//test();

exports.getAddressBlocks = getAddressBlocks;
