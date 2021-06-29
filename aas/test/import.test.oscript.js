// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { expect } = require('chai')
const path = require('path')
const crypto = require('crypto')

function sha256(str) {
	return crypto.createHash("sha256").update(str, "utf8").digest("base64");
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
			.with.wallet({ oracle: 1e9 })
			.with.wallet({ alice: 100e9 })
			.with.wallet({ bob: 100e9 })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		this.oracle = this.network.wallet.oracle
		this.oracleAddress = await this.oracle.getAddress()
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
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
		this.counterstake_coef = 1.3
		this.min_price = 25 // actual is 30

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
				large_threshold: 1000e9,
				min_price: this.min_price,
				oracles: this.oracleAddress + '*ETH_USD ' + this.oracleAddress + '/GBYTE_USD',
			},
		})
		console.log(unit, error)

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
			large_threshold: 1000e9,
			min_price: this.min_price,
			oracles: [
				{ oracle: this.oracleAddress, feed_name: 'ETH_USD', op: '*' },
				{ oracle: this.oracleAddress, feed_name: 'GBYTE_USD', op: '/' },
			],
		})

	})

	it("Bob claims some coins but forgets about the fee", async () => {
		this.txid = '0x888dead333beef'
		this.amount = 0.5e8
		this.sender_address = '0xA7a2448D91AA5E09b217D94AA78bB1c7A8dAE01f'
		this.txts = Math.floor((await this.bob.getTime()).time/1000)
		this.stake_amount = Math.ceil(this.amount / 1e8 * 600 / 20 * 1e9 * this.ratio)
		
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.stake_amount,
			data: {
				txid: this.txid,
				txts: this.txts,
				amount: this.amount,
				sender_address: this.sender_address,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("received stake " + (this.stake_amount - 2000) + " is less than the required stake " + this.stake_amount)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
	})

	it('Bob claims some coins', async () => {
		this.txid = '0x888dead333beef'
		this.amount = 0.5e8
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
		expect(vars['o_' + this.claim_num]).to.deep.eq(this.claim)
		expect(vars['1_yes_by_' + this.bobAddress]).to.be.eq(this.stake_amount)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.bobAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it('Bob tries to claim the same coins again', async () => {
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

		expect(response.response.error).to.be.eq("this transfer has already been claimed")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
	})

	it("Alice tries to support Bob's claim while it's not needed", async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e6 + 2000,
			data: {
				claim_num: this.claim_num,
				stake_on: 'yes',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("the outcome yes is already current")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
	})

	it("Alice challenges the Bob's claim with a small stake", async () => {
		this.alice_challenge = Math.round(this.stake_amount * 0.5)
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.alice_challenge + 2000,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim.stakes.no += this.alice_challenge

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq("current outcome stays yes. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 14 hours.")
	
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('after challenging vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.eq(this.claim)
		expect(vars['1_yes_by_' + this.bobAddress]).to.be.eq(this.stake_amount)
		expect(vars['1_no_by_' + this.aliceAddress]).to.be.eq(this.alice_challenge)

	})

	it('Bob tries to withdraw without waiting', async () => {
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

		expect(response.response.error).to.be.eq("challenging period is still ongoing")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it("Bob waits and withdraws successfully, the Alice's challenge fails", async () => {
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
		expect(vars['1_no_by_' + this.aliceAddress]).to.be.eq(this.alice_challenge)
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.eq(this.claim)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: this.stake_amount + this.alice_challenge,
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

	it('Bob tries to withdraw again', async () => {
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

		expect(response.response.error).to.be.eq("already issued")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Alice tries to withdraw her failed stake', async () => {
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

		expect(response.response.error).to.be.eq("you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob tries to claim the same coins again after withdrawing', async () => {
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
		await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("this transfer has already been claimed")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.validUnit
	})




	it("Alice claims some coins she didn't receive", async () => {
		this.aa_balance = (await this.alice.getOutputsBalanceOf(this.import_aa)).base.total
		expect(this.aa_balance).to.be.lte(10e4)
		
		this.txid2 = '0xbad888dead333beef'
		this.amount2 = 0.3e8
		this.reward2 = 0
		this.sender_address2 = '0xAF1560d62D5a107c5dD448DEEb554B1784965A5C'
		this.txts2 = Math.floor((await this.alice.getTime()).time/1000)
		this.claim_hash2 = sha256(this.sender_address2 + '_' + this.aliceAddress + '_' + this.txid2 + '_' + this.txts2 + '_' + this.amount2 + '_' + this.reward2 + '_')
		this.stake_amount2 = Math.ceil(this.amount2 / 1e8 * 600 / 20 * 1e9 * this.ratio)
		
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: this.stake_amount2 + 2000,
			data: {
				txid: this.txid2,
				txts: this.txts2,
				amount: this.amount2,
				reward: this.reward2,
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
	
		this.claim_num2 = 2
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
				yes: this.stake_amount2,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.stake_amount2 * this.counterstake_coef,
		}

		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('after initial Alice vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.stake_amount2)
		expect(vars['claim_num']).to.be.eq(this.claim_num2)
		expect(vars['num_' + this.claim_hash2]).to.be.eq(this.claim_num2)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num2]).to.be.eq(this.amount2)
	})

	it("Bob challenges her claim but his amount is not sufficient to overturn the outcome", async () => {
		const stake = Math.round(this.stake_amount2 * 1.1)
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: stake + 2000,
			data: {
				claim_num: this.claim_num2,
				stake_on: 'no',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim2.stakes.no += stake
		this.bob_stake_no = stake

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['message']).to.be.eq("current outcome stays yes. Total staked " + this.claim2.stakes.yes + " on yes, " + this.claim2.stakes.no + " on no. Expires in 14 hours.")
	
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('after Bob vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.stake_amount2)
		expect(vars['2_no_by_' + this.bobAddress]).to.be.eq(stake)
	})

	it("Alice supports Bob's challenge and overturns the outcome", async () => {
		const stake = Math.round(this.stake_amount2 * 0.3)
		const accepted_stake = this.claim2.challenging_target - this.claim2.stakes.no
		const excess = stake - accepted_stake
		console.log({stake, accepted_stake, excess})
		expect(excess).to.be.gt(0)
		this.alice_stake_no = accepted_stake

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: stake + 2000,
			data: {
				claim_num: this.claim_num2,
				stake_on: 'no',
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		this.claim2.stakes.no += accepted_stake
		this.claim2.current_outcome = 'no'
		this.claim2.period_number = 1
		this.claim2.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim2.challenging_target = Math.ceil(this.counterstake_coef * this.claim2.challenging_target)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("current outcome became no. Total staked " + this.claim2.stakes.yes + " on yes, " + this.claim2.stakes.no + " on no. Expires in 72 hours.")
	
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('after Alice vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.stake_amount2)
		expect(vars['2_no_by_' + this.bobAddress]).to.be.eq(this.bob_stake_no)
		expect(vars['2_no_by_' + this.aliceAddress]).to.be.eq(accepted_stake)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: excess,
			},
		])
	})

	it('Bob waits too little and tries to withdraw', async () => {
		const { time_error } = await this.network.timetravel({shift: '15h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
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

	it('Bob waits more and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: (72 - 15) + 'h' })
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num2)
	
		const { vars } = await this.bob.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.stake_amount2)
		expect(vars['2_no_by_' + this.bobAddress]).to.be.undefined
		expect(vars['2_no_by_' + this.aliceAddress]).to.be.eq(this.alice_stake_no)
		expect(vars['o_' + this.claim_num2]).to.be.undefined
		expect(vars['f_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: Math.floor(this.bob_stake_no/(this.bob_stake_no + this.alice_stake_no) * (this.stake_amount2 + this.bob_stake_no + this.alice_stake_no)),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.eq({
			claim_num: this.claim_num2,
			sender_address: this.sender_address2,
			address: this.aliceAddress,
			amount: this.amount2,
		})
	})

	it('Alice withdraws too', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars).to.be.undefined
	
		const { vars } = await this.alice.readAAStateVars(this.import_aa)
		console.log('vars', vars)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.stake_amount2)
		expect(vars['2_no_by_' + this.bobAddress]).to.be.undefined
		expect(vars['2_no_by_' + this.aliceAddress]).to.be.undefined
		expect(vars['o_' + this.claim_num2]).to.be.undefined
		expect(vars['f_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: Math.floor(this.alice_stake_no/(this.bob_stake_no + this.alice_stake_no) * (this.stake_amount2 + this.bob_stake_no + this.alice_stake_no)),
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.be.deep.eq({
			claim_num: this.claim_num2,
			sender_address: this.sender_address2,
			address: this.aliceAddress,
			amount: this.amount2,
		})

		// check that AA balance didn't change (neglecting the fees)
		const new_aa_balance = (await this.alice.getOutputsBalanceOf(this.import_aa)).base.total
		expect(new_aa_balance).to.be.gte(this.aa_balance)
		expect(new_aa_balance).to.be.lte(this.aa_balance + 6e4) // bounce fees
	})

	it('Alice tries to withdraw again', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.import_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob repatriates some coins', async () => {
		this.home_address = '0xdeadbeef'
		const data = {b: 8, a: 'nn'}
		const { unit, error } = await this.bob.sendMulti({
			asset: this.asset,
			base_outputs: [{ address: this.import_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.import_aa, amount: this.amount }],
			messages: [{
				app: 'data',
				payload: {
					home_address: this.home_address,
					data,
				}
			}],
			spend_unconfirmed: 'all',
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['home_address']).to.be.equal(this.home_address)
		expect(response.response.responseVars['reward']).to.be.equal(0)
		expect(response.response.responseVars['amount']).to.be.equal(this.amount)
		expect(response.response.responseVars['data']).to.be.equal('{"a":"nn","b":8}')
		expect(response.response.responseVars['message']).to.be.equal("started repatriation")

	})

	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
