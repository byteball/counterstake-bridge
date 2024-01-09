const { ethers } = require("ethers");
const { request } = require('./request.js');
const { asyncCallWithTimeout } = require('./utils.js');
const network = require('ocore/network.js');

const { constants: { AddressZero } } = ethers;

const nativeSymbols = {
	Ethereum: 'ETH',
	BSC: 'BNB',
	Polygon: 'MATIC',
	Kava: 'KAVA',
};


const cache_lifetime = 60 * 60 * 1000; // 60 minutes

class Cache {
	#data = {};

	get(key, bEvenIfExpired) {
		const record = this.#data[key];
		if (!record)
			return null;
		if (bEvenIfExpired)
			return record.value;
		if (record.ts < Date.now() - cache_lifetime) // expired
			return null;
		return record.value;
	}

	put(key, value) {
		this.#data[key] = { value, ts: Date.now() };
	}
}

const cache = new Cache();

function cachify(func, count_args) {
	return async function() {
		const cached = arguments[count_args]; // the last arg is optional
		const args = [];
		for (let i = 0; i < count_args; i++) // not including the 'cached' arg
			args[i] = arguments[i];
		const key = func.name + '_' + args.join(',');
		if (cached) {
			const value = cache.get(key);
			if (value !== null) {
				console.log(`using cached value ${value} for`, func.name, arguments)
				return value;
			}
		}
		try {
			const value = await asyncCallWithTimeout(func.apply(null, args), 10 * 1000);
			cache.put(key, value);
			return value
		}
		catch (e) {
			console.log(func.name, arguments, 'failed', e);
			const value = cache.get(key, true);
			if (value !== null) {
				console.log(`using expired cached value ${value} for`, func.name, arguments)
				cache.put(key, value);
				return value;
			}
			throw e;
		}
	}
}


const fetchERC20ExchangeRate = async (chain, token_address, quote) => {
	if (process.env.testnet) {
		if (token_address === '0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b') // USDC rinkeby
			token_address = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
		else if (token_address === '0xbF7A7169562078c96f0eC1A8aFD6aE50f12e5A99') // BAT rinkeby
			token_address = '0x0D8775F648430679A709E98d2b0Cb6250d2887EF';
		else if (token_address === '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee') // BUSD testnet
			token_address = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
		else if (token_address === '0x43D8814FdFB9B8854422Df13F1c66e34E4fa91fD') // Kava USDC testnet
			token_address = '0xfA9343C3897324496A05fC75abeD6bAC29f8A40f';
		else {
			console.log(`token ${token_address} not known on ${chain} testnet`);
			return null;
		}
	}
	else if (process.env.devnet) {
		if (token_address === '0xB554fCeDb8E4E0DFDebbE7e58Ee566437A19bfB2') // DAI devnet
			token_address = '0x6b175474e89094c44da98b954eedeac495271d0f';
		else {
			console.log(`token ${token_address} not known on ${chain} devnet`);
			return null;
		}		
	}
	else {
		if (chain === 'kava' && token_address === '0x31f8d38df6514b6cc3C360ACE3a2EFA7496214f6') { // LINE
			console.log(`getting price of LINE`);
			return getObyteAssetPrice('kNWO9R4/oiZ7m+3k4RgBxR2Lrdb/rtfIYB2XKVytCc0=');
		}
	}
	const data = await request(`https://api.coingecko.com/api/v3/coins/${chain}/contract/${token_address.toLowerCase()}`)
	const prices = data.market_data.current_price
	quote = quote.toLowerCase()
	if (!prices[quote]) {
		if (!prices.usd)
			throw new Error(`no ${quote} and no usd in response ${JSON.stringify(data)}`);
		const quote_price_in_usd = await fetchCoingeckoExchangeRateCached(quote, 'USD', true);
		return prices.usd / quote_price_in_usd;
	}
	return prices[quote]
}

function getCoingeckoId(currency) {
	switch (currency) {
		case 'gbyte': return 'byteball';
		case 'eth': return 'ethereum';
		case 'bnb': return 'binancecoin';
		case 'matic': return 'matic-network';
		default: return currency;
	}
}

const fetchCoingeckoExchangeRate = async (in_currency, out_currency) => {
	const id = getCoingeckoId(in_currency.toLowerCase());
	out_currency = out_currency.toLowerCase();
	if (!['usd', 'eth', 'bnb'].includes(out_currency))
		return await fetchCoingeckoExchangeRateCached(id, 'usd') / await fetchCoingeckoExchangeRateCached(out_currency, 'usd');
	const data = await request(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${out_currency}`)
	if (!data[id] || !data[id][out_currency])
		throw new Error(`no ${out_currency} in CG response ${JSON.stringify(data)}`);
	return data[id][out_currency];
}

const fetchCryptocompareExchangeRate = async (in_currency, out_currency) => {
	const data = await request(`https://min-api.cryptocompare.com/data/price?fsym=${in_currency}&tsyms=${out_currency}`)
	if (!data[out_currency])
		throw new Error(`no ${out_currency} in response ${JSON.stringify(data)}`);
	return data[out_currency]
}

const fetchObyteTokenPrices = async () => {
	const data = await request(process.env.testnet ? `https://testnet.ostable.org/r/prices` : `https://referrals.ostable.org/prices`)
	const prices = data.data
	if (!prices)
		throw Error(`no prices from referrals ${data.error}`);
	return prices
}

function getObyteAssetPrice(asset) {
	const price = network.exchangeRates[asset + '_USD'];
	if (!price)
		throw Error(`no price of ${asset}`);
	return price;
}

const fetchERC20ExchangeRateCached = cachify(fetchERC20ExchangeRate, 3)
const fetchCryptocompareExchangeRateCached = cachify(fetchCryptocompareExchangeRate, 2)
const fetchCoingeckoExchangeRateCached = cachify(fetchCoingeckoExchangeRate, 2)
const fetchObyteTokenPricesCached = cachify(fetchObyteTokenPrices, 0)

const coingeckoChainIds = {
	Ethereum: 'ethereum',
	BSC: 'binance-smart-chain',
	Polygon: 'polygon-pos',
	Kava: 'kava',
};

async function tryGetTokenPrice(network, token_address, nativeSymbol, cached) {
	switch (network) {
		case 'Ethereum':
		case 'BSC':
		case 'Polygon':
		case 'Kava':
			try {
				const chain = coingeckoChainIds[network];
				return await fetchERC20ExchangeRateCached(chain, token_address, nativeSymbol, cached);
			}
			catch (e) {
				console.log(`fetchERC20ExchangeRate for ${network} ${token_address}/${nativeSymbol} failed`, e);
			}
			break;
	}
	return null;
}

// dst_network must be EVM based
async function fetchExchangeRateInNativeAsset(type, dst_network, claimed_asset, src_network, src_asset, cached) {
	const nativeSymbol = nativeSymbols[dst_network];
	if (!nativeSymbol)
		throw Error(`native symbol for network ${dst_network} unknown`);
	if (type === 'repatriation')
		return await tryGetTokenPrice(dst_network, claimed_asset, nativeSymbol, cached);
	let rate = await tryGetTokenPrice(src_network, src_asset, nativeSymbol, cached);
	if (rate)
		return rate;
	if (src_network === 'Obyte') {
		if (src_asset === 'base')
			rate = await fetchCoingeckoExchangeRateCached('GBYTE', nativeSymbol, cached)
		else {
			const prices = await fetchObyteTokenPricesCached(cached);
			const price_in_usd = prices[toMainnetObyteAsset(src_asset)];
			if (!price_in_usd)
				return null;
			const native_price_in_usd = await fetchCoingeckoExchangeRateCached(nativeSymbol, 'USD', cached)
			rate = price_in_usd / native_price_in_usd
		}
	}
	return rate;
}

async function fetchExchangeRateInUSD(network, asset, cached) {
	if (network === 'Obyte') {
		if (asset === 'base')
			return await fetchCoingeckoExchangeRateCached('GBYTE', 'USD', cached);
		const prices = await fetchObyteTokenPricesCached(cached);
		const price_in_usd = prices[toMainnetObyteAsset(asset)];
		return price_in_usd || null;
	}
	if (asset === AddressZero)
		return await fetchCoingeckoExchangeRateCached(nativeSymbols[network], 'USD', cached);
	return await tryGetTokenPrice(network, asset, 'USD', cached);
}

function toMainnetObyteAsset(asset) {
	if (asset === 'nDEJfA3xTO/n0PMBWxlw+ZvgmW9dVELeLaaFZDo8bQ8=') // OUSD devnet
		return '0IwAk71D5xFP0vTzwamKBwzad3I1ZUjZ1gdeB5OnfOg=';
	if (asset === 'CPPYMBzFzI4+eMk7tLMTGjLF4E60t5MUfo2Gq7Y6Cn4=') // OUSD testnet
		return '0IwAk71D5xFP0vTzwamKBwzad3I1ZUjZ1gdeB5OnfOg=';
	if (asset === 'RGJT5nS9Luw2OOlAeOGywxbxwWPXtDAbZfEw5PiXVug=') // IBIT testnet
		return 'viWGuQQnKBkXbuBFryfT3oJd+KHRWMtCDfy7ZEJguaA=';
	return asset;
}



async function test() {
	console.log('BAT', await fetchExchangeRateInNativeAsset('Ethereum', '0x0d8775f648430679a709e98d2b0cb6250d2887ef', 'Obyte', 'BAT-on-Obyte-asset-id', true))
	console.log('GBYTE', await fetchExchangeRateInNativeAsset('Ethereum', 'some-token-address', 'Obyte', 'base', true))
	console.log('SFUSD', await fetchExchangeRateInNativeAsset('Ethereum', 'some-token-address', 'Obyte', '4t1FplfMcmIFg9VrTj0CiwS6/OfWHZ8wZnAr6BW2rvY=', true))
}
//test();

exports.fetchExchangeRateInNativeAsset = fetchExchangeRateInNativeAsset;
exports.fetchExchangeRateInUSD = fetchExchangeRateInUSD;
