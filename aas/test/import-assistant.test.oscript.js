// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const path = require('path')
const crypto = require('crypto')

function sha256(str) {
	return crypto.createHash("sha256").update(str, "utf8").digest("base64");
}

function round(n, precision) {
	return parseFloat(n.toPrecision(precision));
}

function roundObj(obj, precision) {
	let roundedObj = Array.isArray(obj) ? [] : {};
	for (let key in obj) {
		const val = obj[key];
		switch (typeof val) {
			case 'number':
				roundedObj[key] = round(val, precision);
				break;
			case 'object':
				roundedObj[key] = roundObj(val, precision);
				break;
			default:
				roundedObj[key] = val;
		}
	}
	return roundedObj;
}

describe('Creating import transaction', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ ousd: {} })
			.with.agent({ import_base: path.join(__dirname, '../import.oscript') })
			.with.agent({ import_governance_base: path.join(__dirname, '../import-governance.oscript') })
			.with.agent({ import_factory: path.join(__dirname, '../import-factory.oscript') })
			.with.agent({ ia_base: path.join(__dirname, '../import-assistant.oscript') })
			.with.agent({ import_assistant_factory: path.join(__dirname, '../import-assistant-factory.oscript') })
			.with.agent({ assistant_governance_base: path.join(__dirname, '../assistant-governance.oscript') })
			.with.wallet({ alice: 10000e9 })
			.with.wallet({ bob: 10000e9 })
			.with.wallet({ manager: 100e9 })
			.with.wallet({ oracle: 1e9 })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.manager = this.network.wallet.manager
		this.managerAddress = await this.manager.getAddress()
	})

	it('Post data feed', async () => {
		const { unit, error } = await this.oracle.sendMulti({
			messages: [{
				app: 'data_feed',
				payload: {
					GBYTE_USD: 20,
					ETH_USD: 600,
				}
			}],
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { unitObj } = await this.oracle.getUnitInfo({ unit: unit })
		const dfMessage = unitObj.messages.find(m => m.app === 'data_feed')
		expect(dfMessage.payload).to.deep.equalInAnyOrder({
			GBYTE_USD: 20,
			ETH_USD: 600,
		})
		await this.network.witnessUntilStable(unit)
	})

	it('Bob defines a new import bridge', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.stake_asset = 'base'
		this.home_asset = '0x000000000'
		this.home_network = 'eth_net_id'
		this.challenging_periods = [14, 72, 240, 820]
		this.ratio = 1.05
		this.counterstake_coef = 1.5
		this.large_threshold = 10000e9

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.import_factory,
			amount: 10000,
			data: {
				stake_asset: this.stake_asset,
				home_asset: this.home_asset,
				home_network: this.home_network,
				challenging_periods: '14 72 240 820',
				stake_asset_decimals: 9,
				asset_decimals: 8,
				ratio: this.ratio,
				counterstake_coef: this.counterstake_coef,
				large_threshold: this.large_threshold,
				oracles: this.oracleAddress + '*ETH_USD ' + this.oracleAddress + '/GBYTE_USD',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.import_aa = response.response.responseVars['address']

		const { vars: import_vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('import vars', import_vars, this.import_aa)
		expect(Object.keys(import_vars).length).to.be.equal(2)

		this.governance_aa = import_vars['governance_aa']
		this.asset = import_vars['asset']

		const { vars } = await this.bob.readAAStateVars(this.network.agent.import_factory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(1)
		expect(vars['import_' + this.import_aa]).to.deep.equalInAnyOrder({
			asset: this.asset,
			stake_asset: this.stake_asset,
			home_asset: this.home_asset,
			home_network: this.home_network,
			challenging_periods: this.challenging_periods,
			stake_asset_decimals: 9,
			asset_decimals: 8,
			ratio: this.ratio,
			counterstake_coef: this.counterstake_coef,
			large_threshold: this.large_threshold,
			oracles: [
				{ oracle: this.oracleAddress, feed_name: 'ETH_USD', op: '*' },
				{ oracle: this.oracleAddress, feed_name: 'GBYTE_USD', op: '/' },
			],
		})

		this.getStake = amount => Math.ceil(amount/1e8 * 600/20 * 1e9 * this.ratio)

	})


	it('Bob defines a new import assistant', async () => {
		this.management_fee = 0.01
		this.success_fee = 0.2
		this.swap_fee = 0.003
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.import_assistant_factory,
			amount: 10000,
			data: {
				bridge_aa: this.import_aa,
				manager: this.managerAddress,
				management_fee: this.management_fee,
				success_fee: this.success_fee,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.assistant_aa = response.response.responseVars.address
		expect(this.assistant_aa).to.be.validAddress

		this.mf = { stake: 0, image: 0, ts: response.timestamp }
		this.updateMF = async (stake_balance_in_work, image_balance_in_work, days) => {
			const assistant_balance = await this.manager.getOutputsBalanceOf(this.assistant_aa)
			const image_balance = assistant_balance[this.asset] ? assistant_balance[this.asset].total : 0
			this.mf.stake += (assistant_balance.base.total + stake_balance_in_work) * this.management_fee * days/360
			this.mf.image += (image_balance + image_balance_in_work) * this.management_fee * days/360
		}

		this.stake_profit = 0
		this.image_profit = 0

		const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
		console.log('assistant vars', assistant_vars)

		this.shares_asset = assistant_vars['shares_asset']
		expect(this.shares_asset).to.be.validUnit
		expect(assistant_vars.governance_aa).to.be.validAddress
		expect(assistant_vars.stake_profit).to.be.eq(0)
		expect(assistant_vars.image_profit).to.be.eq(0)
		expect(assistant_vars.mf).to.be.deep.eq(this.mf)
		expect(assistant_vars.shares_supply).to.be.undefined

		const { vars } = await this.bob.readAAStateVars(this.network.agent.import_assistant_factory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(1)
		expect(vars['assistant_' + this.assistant_aa]).to.deep.equalInAnyOrder({
			bridge_aa: this.import_aa,
			manager: this.managerAddress,
			management_fee: this.management_fee,
			success_fee: this.success_fee,
			asset: this.asset,
			stake_asset: this.stake_asset,
			shares_asset: this.shares_asset,
		})

	})


	it('Bob claims some coins', async () => {
		this.txid = '0x888dead333beef'
		this.amount = 50e8
		this.reward = 0
		this.sender_address = '0xA7a2448D91AA5E09b217D94AA78bB1c7A8dAE01f'
		this.txts = Math.floor((await this.bob.getTime()).time/1000)
		this.stake_amount = Math.ceil(this.amount/1e8 * 600/20 * 1e9 * this.ratio)
		this.claim_hash = sha256(this.sender_address + '_' + this.bobAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.stake_amount + 2000,
			data: {
				txid: this.txid,
				txts: this.txts,
				amount: this.amount,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")

		this.claim_num = 1
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.bobAddress,
			address: this.bobAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.stake_amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.stake_amount * this.counterstake_coef,
		}
		
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['1_yes_by_' + this.bobAddress]).to.be.eq(this.stake_amount)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.bobAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Bob waits and withdraws successfully", async () => {
		const { time_error } = await this.network.timetravel({shift: '14h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)

		this.claim.issued = true
	
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['1_yes_by_' + this.bobAddress]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.eq(this.claim)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: this.stake_amount,
			},
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: this.amount,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.eq({
			claim_num: this.claim_num,
			sender_address: this.sender_address,
			address: this.bobAddress,
			amount: this.amount,
		})
	})




	it("Bob invests in assistant shares", async () => {
		await this.updateMF(0, 0, 14/24)

		const assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		const stake_amount = 300e9
		const image_amount = 10e8
		this.shares_supply = Math.floor(Math.sqrt((stake_amount + assistant_balance) * image_amount))
		const { unit, error } = await this.bob.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.assistant_aa, amount: stake_amount }],
				[this.asset]: [{ address: this.assistant_aa, amount: image_amount }],
			},
			messages: [{
				app: 'data',
				payload: {
					buy_shares: 1,
				}
			}],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		this.mf.ts = response.timestamp

		const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(vars.stake_profit).to.be.eq(0)
		expect(vars.image_profit).to.be.eq(0)
		expect(roundObj(vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.shares_asset,
				address: this.bobAddress,
				amount: this.shares_supply,
			},
		])
		
	})

	it('Half a year later, manager claims some coins for Alice', async () => {
		const { time_error } = await this.network.timetravel({shift: '180d'})
		expect(time_error).to.be.undefined

		await this.updateMF(0, 0, 180)
		console.log('mf', this.mf)

		this.txid = 'fed79e4e8bd0aca3200a5bc92d0dc10b9ffed8fb633ef4e7658d7f33fe5a12c4'
		this.amount = 2e8
		this.reward = 2e6
		this.sender_address = '0xA7a2448D91AA5E09b217D94AA78bB1c7A8dAE01f'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.getStake(this.amount)
		this.paid_amount = this.amount - this.reward

		this.claim_num = 2

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will claim for " + this.aliceAddress)
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake)
		expect(response.response.responseVars['sent_image_amount']).to.be.eq(this.paid_amount)
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(0)
		expect(assistant_vars.image_profit).to.be.eq(0)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: this.required_stake, image: this.paid_amount })

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.import_aa,
				amount: this.paid_amount,
			},
			{
				address: this.import_aa,
				amount: this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			address: this.aliceAddress,
			txid: this.txid,
			txts: this.txts,
			amount: this.amount,
			reward: this.reward,
			sender_address: this.sender_address,
		})

		// response from bridge AA
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit
		expect(response2.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		const { unitObj: unitObj2 } = await this.manager.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: this.paid_amount,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
		})
	
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.assistant_aa,
			address: this.aliceAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.required_stake,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake * 1.5,
		}

		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['2_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it('Manager tries to claim the same coins again', async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("one of secondary AAs bounced with error: this transfer has already been claimed")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})


	it('Bob waits and triggers a loss but fails', async () => {
		const { time_error } = await this.network.timetravel({shift: '14h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("no such claim or it is not finished yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob withdraws for assistant without being challenged', async () => {
		await this.updateMF(this.required_stake, this.paid_amount, 14/24)
		this.image_profit = this.reward

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
		this.mf.ts = response.timestamp

		this.claim.issued = true
	
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['2_yes_by_' + this.managerAddress]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.assistant_aa,
				amount: this.amount,
			},
			{
				address: this.assistant_aa,
				amount: this.required_stake,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
		})

		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.bob, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['received_stake_amount']).to.be.eq(this.required_stake)
		expect(response2.response.responseVars['received_image_amount']).to.be.eq(this.amount)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.undefined
		expect(response2.response.responseVars['lost_image_amount']).to.be.undefined
		expect(Object.keys(response2.response.responseVars).length).to.be.eq(2)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined

	})

	it('Bob triggers a loss again and fails again', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("this claim is already accounted for")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob tries to withdraw again', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("already issued")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

	})

	it('Manager tries to claim the same coins again after withdrawing', async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("one of secondary AAs bounced with error: this transfer has already been claimed")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})




	it("Alice claims some coins she didn't receive", async () => {
		this.txid2 = '0xbad888dead333beef'
		this.amount2 = 3e8
		this.reward2 = 0
		this.sender_address2 = '0xAF1560d62D5a107c5dD448DEEb554B1784965A5C'
		this.required_stake2 = this.getStake(this.amount2)
		this.txts2 = Math.floor((await this.alice.getTime()).time/1000)
		this.claim_hash2 = sha256(this.sender_address2 + '_' + this.aliceAddress + '_' + this.txid2 + '_' + this.txts2 + '_' + this.amount2 + '_' + this.reward2 + '_')
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.required_stake2 + 2000,
			data: {
				txid: this.txid2,
				txts: this.txts2,
				amount: this.amount2,
				sender_address: this.sender_address2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		this.claim_num2 = 3
		this.claim2 = {
			claim_hash: this.claim_hash2,
			amount: this.amount2,
			reward: this.reward2,
			claimant_address: this.aliceAddress,
			address: this.aliceAddress,
			sender_address: this.sender_address2,
			txid: this.txid2,
			txts: this.txts2,
			stakes: {
				yes: this.required_stake2,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake2 * 1.5,
		}

		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['3_yes_by_' + this.aliceAddress]).to.be.eq(this.required_stake2)
		expect(vars['claim_num']).to.be.eq(this.claim_num2)
		expect(vars['num_' + this.claim_hash2]).to.be.eq(this.claim_num2)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num2]).to.be.eq(this.amount2)
	})

	it("Manager challenges the Alice's claim and overturns the outcome", async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				claim_num: this.claim_num2,
				stake_on: 'no',
			//	stake: this.required_stake2 * 1.5,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num2 + " with no")
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake2 * 1.5)
		this.mf.ts = response.timestamp
	
		this.claim2.stakes.no += this.required_stake2 * 1.5
		this.claim2.current_outcome = 'no'
		this.claim2.period_number = 1
		this.claim2.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim2.challenging_target = 1.5 * this.claim2.challenging_target

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.import_aa,
				amount: 1.5 * this.required_stake2 + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num2,
			stake_on: 'no',
		})

		// response from the bridge
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['message']).to.be.eq("current outcome became no. Total staked " + this.claim2.stakes.yes + " on yes, " + this.claim2.stakes.no + " on no. Expires in 72 hours.")
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['3_yes_by_' + this.aliceAddress]).to.be.eq(this.required_stake2)
		expect(vars['3_no_by_' + this.assistant_aa]).to.be.eq(this.required_stake2 * 1.5)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake2 * 1.5)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num2]).to.be.deep.eq({ stake: this.required_stake2 * 1.5, image: 0 })

	})


	it('Manager waits too little and tries to withdraw', async () => {
		const { time_error } = await this.network.timetravel({shift: '15h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("challenging period is still ongoing")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Manager waits more and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: (72 - 15) + 'h' })
		expect(time_error).to.be.undefined

		await this.updateMF(1.5 * this.required_stake2, 0, 3)
		this.stake_profit += this.required_stake2

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num2)
		this.mf.ts = response.timestamp
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num2 + '_yes_by_' + this.aliceAddress]).to.be.eq(this.required_stake2)
		expect(vars[this.claim_num2 + '_no_by_' + this.assistant_aa]).to.be.undefined
		expect(vars['o_' + this.claim_num2]).to.be.undefined
		expect(vars['f_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: Math.floor(2.5 * this.required_stake2),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num2,
			address: this.aliceAddress,
			amount: this.amount2,
			sender_address: this.sender_address2,
		})

		// assistant's response
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['received_stake_amount']).to.be.eq(2.5 * this.required_stake2)
		expect(response2.response.responseVars['received_image_amount']).to.be.eq(0)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.undefined
		expect(response2.response.responseVars['lost_image_amount']).to.be.undefined

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 13)).to.be.deep.eq(roundObj(this.mf, 13))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num2]).to.be.undefined

	})

	it("After half a year, Bob redeems some shares", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		await this.updateMF(0, 0, 180)
		const gross_assistant_balance = await this.bob.getOutputsBalanceOf(this.assistant_aa)
		const sf = { stake: Math.floor(this.stake_profit * this.success_fee), image: Math.floor(this.image_profit * this.success_fee) }
		const net_assistant_stake_balance = gross_assistant_balance.base.total - this.mf.stake - sf.stake
		const net_assistant_image_balance = gross_assistant_balance[this.asset].total - this.mf.image - sf.image
		const stake_amount = Math.floor(net_assistant_stake_balance / 4 * (1 - this.swap_fee))
		const image_amount = Math.floor(net_assistant_image_balance / 4 * (1 - this.swap_fee))

		const shares_amount = Math.ceil(this.shares_supply / 4)
		this.shares_supply -= shares_amount
		const { unit, error } = await this.bob.sendMulti({
			asset: this.shares_asset,
			base_outputs: [{ address: this.assistant_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.assistant_aa, amount: shares_amount }],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		this.mf.ts = response.timestamp

		const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(vars.stake_profit).to.be.eq(this.stake_profit)
		expect(vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(vars.mf, 13)).to.be.deep.eq(roundObj(this.mf, 13))
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(roundObj(Utils.getExternalPayments(unitObj), 9)).to.deep.equalInAnyOrder(roundObj([
			{
				address: this.bobAddress,
				amount: stake_amount,
			},
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: image_amount,
			},
		], 9))
		
	})

	it("After half a year, manager withdraws his management fee", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		await this.updateMF(0, 0, 180)
		const stake_mf = Math.floor(this.mf.stake)
		const image_mf = Math.floor(this.mf.image)

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				withdraw_management_fee: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		this.mf = { stake: 0, image: 0, ts: response.timestamp }

		const { vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(vars.stake_profit).to.be.eq(this.stake_profit)
		expect(vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.managerAddress,
				amount: stake_mf,
			},
			{
				asset: this.asset,
				address: this.managerAddress,
				amount: image_mf,
			},
		])
		
	})

	it("After another half a year, manager withdraws his success fee", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		await this.updateMF(0, 0, 180)
		const stake_sf = Math.floor(this.stake_profit * this.success_fee)
		const image_sf = Math.floor(this.image_profit * this.success_fee)
		this.stake_profit = 0
		this.image_profit = 0

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				withdraw_success_fee: 1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		this.mf.ts = response.timestamp

		const { vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(vars.stake_profit).to.be.eq(0)
		expect(vars.image_profit).to.be.eq(0)
		expect(roundObj(vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.managerAddress,
				amount: stake_sf,
			},
			{
				asset: this.asset,
				address: this.managerAddress,
				amount: image_sf,
			},
		])
	})



	it('Manager claims more coins for Alice', async () => {
		this.txid = 'db032d0e75fc4e296979015f4baae7f15ef66b3a0024184bb9ac45e7b18c558a'
		this.amount = 2e8
		this.reward = 2e6
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.sender_address = '0xcb22d9c4ed8d8d56296561269d63338f7e899aae'
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.getStake(this.amount)
		this.paid_amount = this.amount - this.reward

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim_num = 4

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will claim for " + this.aliceAddress)
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake)
		expect(response.response.responseVars['sent_image_amount']).to.be.eq(this.paid_amount)
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(0)
		expect(assistant_vars.image_profit).to.be.eq(0)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: this.required_stake, image: this.paid_amount })

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.import_aa,
				amount: this.paid_amount,
			},
			{
				address: this.import_aa,
				amount: this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			txid: this.txid,
			txts: this.txts,
			amount: this.amount,
			reward: this.reward,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})

		// response from bridge AA
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit
		expect(response2.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		const { unitObj: unitObj2 } = await this.manager.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: this.paid_amount,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
		})
	
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.assistant_aa,
			address: this.aliceAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.required_stake,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake * 1.5,
		}
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['4_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Manager challenges his own claim and overturns the outcome", async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
				stake: this.required_stake * 1.5,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake * 1.5)
		this.mf.ts = response.timestamp
	
		this.claim.stakes.no += this.required_stake * 1.5
		this.claim.current_outcome = 'no'
		this.claim.period_number = 1
		this.claim.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim.challenging_target = 1.5 * this.claim.challenging_target

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.import_aa,
				amount: 1.5 * this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			stake_on: 'no',
		})

		// response from the bridge
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['message']).to.be.eq("current outcome became no. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 72 hours.")
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['4_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['4_no_by_' + this.assistant_aa]).to.be.eq(this.required_stake * 1.5)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake * 2.5)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: 2.5 * this.required_stake, image: this.paid_amount })

	})


	it('Manager waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '72h' })
		expect(time_error).to.be.undefined

		await this.updateMF(this.required_stake * 2.5, this.paid_amount, 3)
		this.image_profit -= this.paid_amount

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
		this.mf.ts = response.timestamp
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: Math.floor(2.5 * this.required_stake),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
		})

		// assistant's response
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['received_stake_amount']).to.be.eq(2.5 * this.required_stake)
		expect(response2.response.responseVars['received_image_amount']).to.be.eq(0)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.eq(this.required_stake)
		expect(response2.response.responseVars['lost_image_amount']).to.be.eq(this.paid_amount)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined

	})



	it('Manager claims even more coins for Alice', async () => {
		this.txid = 'ae9c58f5bb8a26a592423944c261ba27ef58a996feda7ca3f2a9e2e828c0c533'
		this.amount = 1e8
		this.reward = 1e6
		this.sender_address = '0xb635f16C2C5a0B6314115fc5ef12Cf494d559678'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.getStake(this.amount)
		this.paid_amount = this.amount - this.reward

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim_num = 5

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will claim for " + this.aliceAddress)
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake)
		expect(response.response.responseVars['sent_image_amount']).to.be.eq(this.paid_amount)
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: this.required_stake, image: this.paid_amount })

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.import_aa,
				amount: this.paid_amount,
			},
			{
				address: this.import_aa,
				amount: this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			txid: this.txid,
			txts: this.txts,
			amount: this.amount,
			reward: this.reward,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})

		// response from bridge AA
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit
		expect(response2.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		const { unitObj: unitObj2 } = await this.manager.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: this.paid_amount,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})
	
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.assistant_aa,
			address: this.aliceAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.required_stake,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake * 1.5,
		}

		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['5_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Manager challenges his own claim but doesn't overturn the outcome", async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
				stake: this.required_stake * 0.1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake * 0.1)
		this.mf.ts = response.timestamp
	
		this.claim.stakes.no += this.required_stake * 0.1

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.import_aa,
				amount: 0.1 * this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			stake_on: 'no',
		})

		// response from the bridge
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['message']).to.be.eq("current outcome stays yes. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 14 hours.")
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['5_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['5_no_by_' + this.assistant_aa]).to.be.eq(this.required_stake * 0.1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake * 1.1)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: 1.1 * this.required_stake, image: this.paid_amount })

	})


	it('Manager waits and withdraws the successful claim 4', async () => {
		const { time_error } = await this.network.timetravel({ shift: '14h' })
		expect(time_error).to.be.undefined

		await this.updateMF(this.required_stake * 1.1, this.paid_amount, 14/24)
		this.image_profit += this.reward

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
		this.mf.ts = response.timestamp

		this.claim.issued = true
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.undefined
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.eq(this.required_stake * 0.1)
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.assistant_aa,
				amount: this.amount,
			},
			{
				address: this.assistant_aa,
				amount: Math.floor(1.1 * this.required_stake),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})

		// assistant's response
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['received_stake_amount']).to.be.eq(1.1 * this.required_stake)
		expect(response2.response.responseVars['received_image_amount']).to.be.eq(this.amount)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.eq(this.required_stake * 0.1)
		expect(response2.response.responseVars['lost_image_amount']).to.be.undefined

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined

	})


	it('Manager makes a 5th claim for Alice', async () => {
		this.txid = '702c8b635b5ce71d6fa9eeed7c0c16dafa7420d2ce0612d3a7e8c2d8f9a5e3f1'
		this.amount = 3e8
		this.reward = 3e6
		this.sender_address = '0xA4e5961B58DBE487639929643dCB1Dc3848dAF5E'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.getStake(this.amount)
		this.paid_amount = this.amount - this.reward

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				txid: this.txid,
				amount: this.amount,
				reward: this.reward,
				txts: this.txts,
				address: this.aliceAddress,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim_num = 6

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will claim for " + this.aliceAddress)
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake)
		expect(response.response.responseVars['sent_image_amount']).to.be.eq(this.paid_amount)
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake)
		expect(assistant_vars.image_balance_in_work).to.be.eq(this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: this.required_stake, image: this.paid_amount })

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.import_aa,
				amount: this.paid_amount,
			},
			{
				address: this.import_aa,
				amount: this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			txid: this.txid,
			txts: this.txts,
			amount: this.amount,
			reward: this.reward,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})

		// response from bridge AA
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.validUnit
		expect(response2.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		const { unitObj: unitObj2 } = await this.manager.getUnitInfo({ unit: response2.response_unit })
		expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: this.paid_amount,
			},
		])
		const data2 = unitObj2.messages.find(m => m.app === 'data').payload
		expect(data2).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})
	
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.assistant_aa,
			address: this.aliceAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.required_stake,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake * 1.5,
		}

		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['6_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Bob challenges the manager's claim and overturns the outcome", async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1.5 * this.required_stake + 2000,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		this.claim.stakes.no += this.required_stake * 1.5
		this.claim.current_outcome = 'no'
		this.claim.period_number = 1
		this.claim.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim.challenging_target = 1.5 * this.claim.challenging_target
	
		expect(response.response.responseVars['message']).to.be.eq("current outcome became no. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 72 hours.")
	
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['6_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars['6_no_by_' + this.bobAddress]).to.be.eq(this.required_stake * 1.5)
	})


	it('Bob waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '72h' })
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
	
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.eq(this.required_stake)
		expect(vars[this.claim_num + '_no_by_' + this.bobAddress]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: Math.floor(2.5 * this.required_stake),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})
	})

	it('Bob triggers a loss', async () => {
		await this.updateMF(this.required_stake, this.paid_amount, 3)
		this.stake_profit -= this.required_stake
		this.image_profit -= this.paid_amount

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq("recorded a loss in claim " + this.claim_num)
		expect(response.response.responseVars.lost_stake_amount).to.be.eq(this.required_stake)
		expect(response.response.responseVars.lost_image_amount).to.be.eq(this.paid_amount)
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined
	})



	it("Claim 7: Alice claims some coins", async () => {
		this.txid = 'c7bfb83a8194f08f3e6820e26ec04e1f321ee0f083319a57274ba85c34207958'
		this.amount = 5e8
		this.reward = 0
		this.required_stake = this.getStake(this.amount)
		this.txts = Math.floor((await this.alice.getTime()).time/1000)
		this.sender_address = '0xE9B1a2164368c00FC93e0e749d9B3cAFA1bC6eE2'
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.required_stake + 2000,
			data: {
				txid: this.txid,
				txts: this.txts,
				amount: this.amount,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim_num = 7

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq("challenging period expires in 14 hours")
	
		this.claim = {
			claim_hash: this.claim_hash,
			amount: this.amount,
			reward: this.reward,
			claimant_address: this.aliceAddress,
			address: this.aliceAddress,
			sender_address: this.sender_address,
			txid: this.txid,
			txts: this.txts,
			stakes: {
				yes: this.required_stake,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.required_stake * 1.5,
		}
		
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['7_yes_by_' + this.aliceAddress]).to.be.eq(this.required_stake)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Manager challenges the Alice's claim but doesn't overturn the outcome", async () => {
		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
				stake: this.required_stake * 0.1,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_stake_amount']).to.be.eq(this.required_stake * 0.1)
		this.mf.ts = response.timestamp
	
		this.claim.stakes.no += this.required_stake * 0.1

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.import_aa,
				amount: 0.1 * this.required_stake + 2000,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			stake_on: 'no',
		})

		// response from the bridge
		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.manager, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['message']).to.be.eq("current outcome stays yes. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 14 hours.")
	
		const { vars } = await this.manager.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['7_yes_by_' + this.aliceAddress]).to.be.eq(this.required_stake)
		expect(vars['7_no_by_' + this.assistant_aa]).to.be.eq(this.required_stake * 0.1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(this.required_stake * 0.1)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.deep.eq({ stake: 0.1 * this.required_stake, image: 0 })

	})

	it('Alice waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '14h' })
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)

		this.claim.issued = true
	
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.aliceAddress]).to.be.undefined
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.eq(0.1 * this.required_stake)
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.eq(this.claim)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.aliceAddress,
				amount: Math.floor(this.amount),
			},
			{
				address: this.aliceAddress,
				amount: Math.floor(1.1 * this.required_stake),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			address: this.aliceAddress,
		})

	})


	it('Bob triggers a loss', async () => {
		await this.updateMF(0.1 * this.required_stake, 0, 14/24)
		this.stake_profit -= 0.1 * this.required_stake

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq("recorded a loss in claim " + this.claim_num)
		expect(response.response.responseVars.lost_stake_amount).to.be.eq(0.1 * this.required_stake)
		expect(response.response.responseVars.lost_image_amount).to.be.undefined
		this.mf.ts = response.timestamp

		const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
		console.log('assistant vars', assistant_vars)
		console.log('stake profit', this.stake_profit)
		console.log('image profit', this.image_profit)
		console.log('mf', this.mf)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined
	})


	it('Bob swaps image asset for stake asset', async () => {
		const assistant_balance = await this.bob.getOutputsBalanceOf(this.assistant_aa)
		
		const stake_balance = assistant_balance.base.total - this.mf.stake - Math.max(Math.floor(this.stake_profit * this.success_fee), 0)
		const image_balance = assistant_balance[this.asset].total - this.mf.image - Math.max(Math.floor(this.image_profit * this.success_fee), 0)

		const image_amount = 1e8
		const stake_amount = Math.floor((stake_balance - stake_balance * image_balance / (image_balance + image_amount)) * (1 - this.swap_fee))
		console.log('expected from swap', { stake_amount })

		const { unit, error } = await this.bob.sendMulti({
			asset: this.asset,
			base_outputs: [{ address: this.assistant_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.assistant_aa, amount: image_amount }],
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
		expect(assistant_vars.image_balance_in_work).to.be.eq(0)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: stake_amount,
			},
		])
	})

	it('Bob swaps stake asset for image asset', async () => {
		const assistant_balance = await this.bob.getOutputsBalanceOf(this.assistant_aa)
		
		const stake_balance = assistant_balance.base.total - this.mf.stake - Math.max(Math.floor(this.stake_profit * this.success_fee), 0)
		const image_balance = assistant_balance[this.asset].total - this.mf.image - Math.max(Math.floor(this.image_profit * this.success_fee), 0)

		const stake_amount = 30e9
		const image_amount = Math.floor((image_balance - stake_balance * image_balance / (stake_balance + stake_amount)) * (1 - this.swap_fee))
		console.log('expected from swap', { image_amount })

		const { unit, error } = await this.bob.sendBytes({
			toAddress: this.assistant_aa,
			amount: stake_amount,
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.stake_profit).to.be.eq(this.stake_profit)
		expect(assistant_vars.image_profit).to.be.eq(this.image_profit)
		expect(roundObj(assistant_vars.mf, 12)).to.be.deep.eq(roundObj(this.mf, 12))
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.stake_balance_in_work).to.be.eq(0)
	/	expect(assistant_vars.image_balance_in_work).to.be.eq(0)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				asset: this.asset,
				address: this.bobAddress,
				amount: image_amount,
			},
		])
	})



	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
