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

describe('Creating export transaction', function () {
	this.timeout(120000)

	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ ousd: {} })
			.with.agent({ export_base: path.join(__dirname, '../export.oscript') })
			.with.agent({ export_governance_base: path.join(__dirname, '../export-governance.oscript') })
			.with.agent({ export_factory: path.join(__dirname, '../export-factory.oscript') })
			.with.agent({ ea_base: path.join(__dirname, '../export-assistant.oscript') })
			.with.agent({ export_assistant_factory: path.join(__dirname, '../export-assistant-factory.oscript') })
			.with.agent({ assistant_governance_base: path.join(__dirname, '../assistant-governance.oscript') })
			.with.wallet({ alice: 100e9 })
			.with.wallet({ bob: 100e9 })
			.with.wallet({ manager: 100e9 })
		//	.with.explorer()
			.run()
		
		console.log('--- agents\n', this.network.agent)
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		this.manager = this.network.wallet.manager
		this.managerAddress = await this.manager.getAddress()
	})

	it('Bob defines a new export bridge', async () => {
		const { error: tf_error } = await this.network.timefreeze()
		expect(tf_error).to.be.null

		this.asset = 'base'
		this.foreign_asset = 'foreign_base'
		this.foreign_network = 'net_id'
		this.challenging_periods = [14, 72, 240, 820]
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.export_factory,
			amount: 10000,
			data: {
				asset: this.asset,
				asset_decimals: 9,
				foreign_asset: this.foreign_asset,
				foreign_network: this.foreign_network,
				challenging_periods: '14 72 240 820',
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

		this.export_aa = response.response.responseVars.address
		expect(this.export_aa).to.be.validAddress

		const { vars } = await this.bob.readAAStateVars(this.network.agent.export_factory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(2)
		expect(vars['export_' + this.export_aa]).to.deep.equalInAnyOrder({
			asset: this.asset,
			asset_decimals: 9,
			foreign_asset: this.foreign_asset,
			foreign_network: this.foreign_network,
			challenging_periods: this.challenging_periods,
		})
		expect(vars['aa_' + this.foreign_network + '_' + this.foreign_asset]).to.be.eq(this.export_aa)

		const { vars: export_vars } = await this.bob.readAAStateVars(this.export_aa)
		console.log('export vars', export_vars, this.export_aa)

		this.governance_aa = export_vars['governance_aa']
	})

	it('Bob defines a new export assistant', async () => {
		this.management_fee = 0.01
		this.success_fee = 0.2
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.export_assistant_factory,
			amount: 10000,
			data: {
				bridge_aa: this.export_aa,
				manager: this.managerAddress,
				management_fee: this.management_fee,
				success_fee: this.success_fee,
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

		this.assistant_aa = response.response.responseVars.address
		expect(this.assistant_aa).to.be.validAddress

		const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
		console.log('assistant vars', assistant_vars)

		this.shares_asset = assistant_vars['shares_asset']
		expect(this.shares_asset).to.be.validUnit
	//	expect(assistant_vars.governance_aa).to.be.validAddress
		expect(assistant_vars.profit).to.be.eq(0)
		expect(assistant_vars.mf).to.be.eq(0)
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.undefined

		const { vars } = await this.bob.readAAStateVars(this.network.agent.export_assistant_factory)
		console.log('vars', vars)
		expect(Object.keys(vars).length).to.be.equal(1)
		expect(vars['assistant_' + this.assistant_aa]).to.deep.eq({
			bridge_aa: this.export_aa,
			manager: this.managerAddress,
			management_fee: this.management_fee,
			success_fee: this.success_fee,
			stake_asset: this.asset,
			shares_asset: this.shares_asset,
		})
	})

	it('Alice exports some coins', async () => {
		this.foreign_address = '0xdeadbeef'
		this.reward = 1e7
		const amount = 10e9
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.export_aa,
			amount: amount,
			data: {
				foreign_address: this.foreign_address,
				reward: this.reward,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars['foreign_address']).to.be.equal(this.foreign_address)
		expect(response.response.responseVars['reward']).to.be.equal(this.reward)
		expect(response.response.responseVars['amount']).to.be.equal(amount)
		expect(response.response.responseVars['message']).to.be.equal("started expatriation")

	})

	it("Bob invests in assistant shares", async () => {
		const assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total

		const amount = 50e9
		this.shares_supply = amount + assistant_balance
		const { unit, error } = await this.bob.sendBytes({
			toAddress: this.assistant_aa,
			amount: amount,
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(vars.profit).to.be.eq(0)
		expect(vars.mf).to.be.eq(0)
		expect(vars.ts).to.be.eq(response.timestamp)
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

		const assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		expect(assistant_balance).to.be.lt(this.shares_supply) // because of the fees paid for sending shares
		this.mf = assistant_balance * this.management_fee / 2 // fractional
		console.log('mf', this.mf)

		this.txid = '888dead333beef'
		this.amount = 4e9
		this.reward = 4e7
		this.sender_address = '0xA7a2448D91AA5E09b217D94AA78bB1c7A8dAE01f'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.data = { b: 8, a: 'nn' }
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_' + '{"a":"nn","b":8}')
		this.required_stake = this.amount
		this.paid_amount = this.amount - this.reward
		const total = this.required_stake + this.paid_amount

		this.claim_num = 1

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
				data: this.data,
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
		expect(response.response.responseVars['sent_amount']).to.be.eq(total)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(0)
		expect(assistant_vars.mf).to.be.eq(round(this.mf, 15))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(total)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(total)

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: this.required_stake + this.paid_amount + 2000,
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
			data: this.data,
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
			data: this.data,
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
				yes: this.amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount * 1.5,
			data: this.data,
		}

		const { vars } = await this.bob.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['1_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
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
				data: this.data,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq(`one of secondary AAs bounced with error: ${this.export_aa}: this transfer has already been claimed`)
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
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("no such claim or it is not finished yet")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})

	it('Bob withdraws for assistant without being challenged', async () => {
		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += this.paid_amount + this.required_stake // balance in work
		this.mf += assistant_balance * this.management_fee * 14 / 24 / 360 // fractional
		this.profit = this.reward

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
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
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)

		this.claim.withdrawn = true
	
		const { vars } = await this.bob.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['1_yes_by_' + this.assistant_aa]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.eq(this.claim)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: 2*this.amount,
			},
		])
		const data = unitObj.messages.find(m => m.app === 'data').payload
		expect(data).to.deep.eq({
			claim_num: this.claim_num,
			address: this.aliceAddress,
			amount: this.amount,
			sender_address: this.sender_address,
			data: this.data,
		})

		const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.bob, response.response_unit)
		expect(response2.response.error).to.be.undefined
		expect(response2.bounced).to.be.false
		expect(response2.response_unit).to.be.null
		expect(response2.response.responseVars['received_amount']).to.be.eq(2*this.amount)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.undefined
		expect(Object.keys(response2.response.responseVars).length).to.be.eq(1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(assistant_vars.mf).to.be.eq(round(this.mf, 15))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
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
		console.log(unit, error)

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
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq("already withdrawn")
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
				data: this.data,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.eq(`one of secondary AAs bounced with error: ${this.export_aa}: this transfer has already been claimed`)
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})




	it("Alice claims some coins she didn't receive", async () => {
		this.aa_balance = (await this.alice.getOutputsBalanceOf(this.export_aa)).base.total
		expect(this.aa_balance).to.be.gte(this.amount)
		
		this.txid2 = '0xbad888dead333beef'
		this.amount2 = 3e9
		this.reward2 = 0
		this.sender_address2 = '0xAF1560d62D5a107c5dD448DEEb554B1784965A5C'
		this.txts2 = Math.floor((await this.alice.getTime()).time/1000)
		this.claim_hash2 = sha256(this.sender_address2 + '_' + this.aliceAddress + '_' + this.txid2 + '_' + this.txts2 + '_' + this.amount2 + '_' + this.reward2 + '_')
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.export_aa,
			amount: this.amount2 + 2000,
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
				yes: this.amount2,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount2 * 1.5,
		}

		const { vars } = await this.alice.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.amount2)
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
				stake: this.amount2 * 1.5,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num2 + " with no")
		expect(response.response.responseVars['sent_amount']).to.be.eq(this.amount2 * 1.5)
	
		this.claim2.stakes.no += this.amount2 * 1.5
		this.claim2.current_outcome = 'no'
		this.claim2.period_number = 1
		this.claim2.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim2.challenging_target = 1.5 * this.claim2.challenging_target

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: 1.5 * this.amount2 + 2000,
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
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)
		expect(vars['2_yes_by_' + this.aliceAddress]).to.be.eq(this.amount2)
		expect(vars['2_no_by_' + this.assistant_aa]).to.be.eq(this.amount2 * 1.5)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(assistant_vars.mf).to.be.eq(round(this.mf, 15))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(this.amount2 * 1.5)
		expect(assistant_vars['claim_' + this.claim_num2]).to.be.eq(this.amount2 * 1.5)

	})


	it('Manager waits too little and tries to withdraw', async () => {
		const { time_error } = await this.network.timetravel({shift: '15h'})
		expect(time_error).to.be.undefined

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
				address: this.assistant_aa,
			},
		})
		console.log(unit, error)

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

		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += 1.5 * this.amount2 // balance in work
		this.mf += assistant_balance * this.management_fee * 72 / 24 / 360 // fractional
		this.profit += this.amount2

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num2,
				address: this.assistant_aa,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num2)
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num2 + '_yes_by_' + this.aliceAddress]).to.be.eq(this.amount2)
		expect(vars[this.claim_num2 + '_no_by_' + this.assistant_aa]).to.be.undefined
		expect(vars['o_' + this.claim_num2]).to.be.undefined
		expect(vars['f_' + this.claim_num2]).to.deep.equalInAnyOrder(this.claim2)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: Math.floor(2.5 * this.amount2),
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
		expect(response2.response.responseVars['received_amount']).to.be.eq(2.5 * this.amount2)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.undefined

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num2]).to.be.undefined

	})

	it("After half a year, Bob redeems some shares", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		const gross_assistant_balance = (await this.bob.getOutputsBalanceOf(this.assistant_aa)).base.total
		this.mf += gross_assistant_balance * this.management_fee * 180 / 360 // fractional
		const sf = Math.floor(this.profit * 0.2)
		const net_assistant_balance = gross_assistant_balance - this.mf - sf
		const amount = Math.floor(net_assistant_balance / 4)

		const shares_amount = Math.ceil(this.shares_supply / 4)
		this.shares_supply -= shares_amount
		const { unit, error } = await this.bob.sendMulti({
			asset: this.shares_asset,
			base_outputs: [{ address: this.assistant_aa, amount: 1e4 }],
			asset_outputs: [{ address: this.assistant_aa, amount: shares_amount }],
			spend_unconfirmed: 'all',
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
		expect(vars.profit).to.be.eq(this.profit)
		expect(round(vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(vars.ts).to.be.eq(response.timestamp)
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: amount,
			},
		])
		
	})

	it("After half a year, manager withdraws his management fee", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		const gross_assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		this.mf += gross_assistant_balance * this.management_fee * 180 / 360 // fractional
		const mf = Math.floor(this.mf)
		this.mf = 0;

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				withdraw_management_fee: 1,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(vars.profit).to.be.eq(this.profit)
		expect(vars.mf).to.be.eq(0)
		expect(vars.ts).to.be.eq(response.timestamp)
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.managerAddress,
				amount: mf,
			},
		])
		
	})

	it("After another half a year, manager withdraws his success fee", async () => {
		const { time_error } = await this.network.timetravel({ shift: '180d' })
		expect(time_error).to.be.undefined

		const gross_assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		this.mf += gross_assistant_balance * this.management_fee * 180 / 360 // fractional
		const sf = Math.floor(this.profit * 0.2)
		this.profit = 0

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				withdraw_success_fee: 1,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(vars.profit).to.be.eq(0)
		expect(round(vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(vars.ts).to.be.eq(response.timestamp)
		expect(vars.shares_supply).to.be.eq(this.shares_supply)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.managerAddress,
				amount: sf,
			},
		])
	})



	it('Manager claims more coins for Alice', async () => {
		this.txid = 'db032d0e75fc4e296979015f4baae7f15ef66b3a0024184bb9ac45e7b18c558a'
		this.amount = 2e9
		this.reward = 2e7
		this.txts = Math.floor((await this.manager.getTime()).time / 1000)
		this.sender_address = '0xcb22d9c4ed8d8d56296561269d63338f7e899aae'
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.amount
		this.paid_amount = this.amount - this.reward
		const total = this.required_stake + this.paid_amount

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

		this.claim_num = 3

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will claim for " + this.aliceAddress)
		expect(response.response.responseVars['sent_amount']).to.be.eq(total)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(0)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(total)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(total)

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: this.required_stake + this.paid_amount + 2000,
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
				yes: this.amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount * 1.5,
		}

		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['3_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
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
				stake: this.amount * 1.5,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_amount']).to.be.eq(this.amount * 1.5)
	
		this.claim.stakes.no += this.amount * 1.5
		this.claim.current_outcome = 'no'
		this.claim.period_number = 1
		this.claim.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim.challenging_target = 1.5 * this.claim.challenging_target

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: 1.5 * this.amount + 2000,
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
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['3_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars['3_no_by_' + this.assistant_aa]).to.be.eq(this.amount * 1.5)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(this.amount * 2.5 + this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(this.amount * 2.5 + this.paid_amount)

	})


	it('Manager waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '72h' })
		expect(time_error).to.be.undefined

		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += this.paid_amount + this.required_stake + 1.5 * this.amount // balance in work
		this.mf += assistant_balance * this.management_fee * 72 / 24 / 360 // fractional
		this.profit -= this.paid_amount

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: Math.floor(2.5 * this.amount),
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
		expect(response2.response.responseVars['received_amount']).to.be.eq(2.5 * this.amount)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.eq(this.amount)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined

	})



	it('Manager claims even more coins for Alice', async () => {
		this.txid = 'ae9c58f5bb8a26a592423944c261ba27ef58a996feda7ca3f2a9e2e828c0c533'
		this.amount = 1e9
		this.reward = 1e7
		this.sender_address = '0xb635f16C2C5a0B6314115fc5ef12Cf494d559678'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.amount
		this.paid_amount = this.amount - this.reward
		const total = this.required_stake + this.paid_amount

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
		expect(response.response.responseVars['sent_amount']).to.be.eq(total)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(total)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(total)

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: this.required_stake + this.paid_amount + 2000,
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
				yes: this.amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount * 1.5,
		}

		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['4_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
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
				stake: this.amount * 0.1,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_amount']).to.be.eq(this.amount * 0.1)
	
		this.claim.stakes.no += this.amount * 0.1

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: 0.1 * this.amount + 2000,
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
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['4_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars['4_no_by_' + this.assistant_aa]).to.be.eq(this.amount * 0.1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(this.amount * 1.1 + this.paid_amount)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(this.amount * 1.1 + this.paid_amount)

	})


	it('Manager waits and withdraws the successful claim 4', async () => {
		const { time_error } = await this.network.timetravel({ shift: '14h' })
		expect(time_error).to.be.undefined

		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += this.paid_amount + this.required_stake + 0.1 * this.amount // balance in work
		this.mf += assistant_balance * this.management_fee * 14 / 24 / 360 // fractional
		this.profit += this.reward

		const { unit, error } = await this.manager.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
				address: this.assistant_aa,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)

		this.claim.withdrawn = true
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.undefined
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.eq(this.amount * 0.1)
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.assistant_aa,
				amount: Math.floor(2.1 * this.amount),
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
		expect(response2.response.responseVars['received_amount']).to.be.eq(2.1 * this.amount)
		expect(response2.response.responseVars['lost_stake_amount']).to.be.eq(this.amount * 0.1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined

	})



	it('Manager makes a 5th claim for Alice', async () => {
		this.txid = '702c8b635b5ce71d6fa9eeed7c0c16dafa7420d2ce0612d3a7e8c2d8f9a5e3f1'
		this.amount = 3e9
		this.reward = 3e7
		this.sender_address = '0xA4e5961B58DBE487639929643dCB1Dc3848dAF5E'
		this.txts = Math.floor((await this.manager.getTime()).time/1000)
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		this.required_stake = this.amount
		this.paid_amount = this.amount - this.reward
		const total = this.required_stake + this.paid_amount

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
		expect(response.response.responseVars['sent_amount']).to.be.eq(total)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(total)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(total)

		// assistant to bridge
		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: this.required_stake + this.paid_amount + 2000,
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
				yes: this.amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount * 1.5,
		}

		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['5_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars['claim_num']).to.be.eq(this.claim_num)
		expect(vars['num_' + this.claim_hash]).to.be.eq(this.claim_num)
		expect(vars['address_' + this.aliceAddress + '_' + this.claim_num]).to.be.eq(this.amount)
	})

	it("Bob challenges the manager's claim and overturns the outcome", async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1.5 * this.amount + 2000,
			data: {
				claim_num: this.claim_num,
				stake_on: 'no',
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		this.claim.stakes.no += this.amount * 1.5
		this.claim.current_outcome = 'no'
		this.claim.period_number = 1
		this.claim.expiry_ts = response.timestamp + this.challenging_periods[1] * 3600
		this.claim.challenging_target = 1.5 * this.claim.challenging_target
	
		expect(response.response.responseVars['message']).to.be.eq("current outcome became no. Total staked " + this.claim.stakes.yes + " on yes, " + this.claim.stakes.no + " on no. Expires in 72 hours.")
	
		const { vars } = await this.bob.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['5_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars['5_no_by_' + this.bobAddress]).to.be.eq(this.amount * 1.5)
	})


	it('Bob waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '72h' })
		expect(time_error).to.be.undefined

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
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
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)
	
		const { vars } = await this.bob.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.assistant_aa]).to.be.eq(this.amount)
		expect(vars[this.claim_num + '_no_by_' + this.bobAddress]).to.be.undefined
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.bobAddress,
				amount: Math.floor(2.5 * this.amount),
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
		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += this.paid_amount + this.required_stake  // balance in work
		this.mf += assistant_balance * this.management_fee * 72 / 24 / 360 // fractional
		this.profit -= this.paid_amount + this.required_stake

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq("recorded a loss in claim " + this.claim_num)
		expect(response.response.responseVars.lost_amount).to.be.eq(this.paid_amount + this.required_stake)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined
	})



	it("Claim 6: Alice claims some coins", async () => {
		this.aa_balance = (await this.alice.getOutputsBalanceOf(this.export_aa)).base.total
		expect(this.aa_balance).to.be.gte(this.amount)
		
		this.txid = 'c7bfb83a8194f08f3e6820e26ec04e1f321ee0f083319a57274ba85c34207958'
		this.amount = 5e9
		this.reward = 0
		this.txts = Math.floor((await this.alice.getTime()).time / 1000)
		this.sender_address = '0xE9B1a2164368c00FC93e0e749d9B3cAFA1bC6eE2'
		this.claim_hash = sha256(this.sender_address + '_' + this.aliceAddress + '_' + this.txid + '_' + this.txts + '_' + this.amount + '_' + this.reward + '_')
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.export_aa,
			amount: this.amount + 2000,
			data: {
				txid: this.txid,
				txts: this.txts,
				amount: this.amount,
				sender_address: this.sender_address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		this.claim_num = 6

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
				yes: this.amount,
				no: 0,
			},
			current_outcome: 'yes',
			is_large: false,
			period_number: 0,
			ts: response.timestamp,
			expiry_ts: response.timestamp + this.challenging_periods[0] * 3600,
			challenging_target: this.amount * 1.5,
		}

		const { vars } = await this.alice.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['6_yes_by_' + this.aliceAddress]).to.be.eq(this.amount)
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
				stake: this.amount * 0.1,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.manager, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("will challenge " + this.claim_num + " with no")
		expect(response.response.responseVars['sent_amount']).to.be.eq(this.amount * 0.1)
	
		this.claim.stakes.no += this.amount * 0.1

		const { unitObj } = await this.manager.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.export_aa,
				amount: 0.1 * this.amount + 2000,
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
	
		const { vars } = await this.manager.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars['o_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)
		expect(vars['6_yes_by_' + this.aliceAddress]).to.be.eq(this.amount)
		expect(vars['6_no_by_' + this.assistant_aa]).to.be.eq(this.amount * 0.1)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 14)).to.be.eq(round(this.mf, 14))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(this.amount * 0.1)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.eq(this.amount * 0.1)

	})

	it('Alice waits and withdraws', async () => {
		const { time_error } = await this.network.timetravel({ shift: '14h' })
		expect(time_error).to.be.undefined

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.export_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				claim_num: this.claim_num,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars['message']).to.be.eq("finished claim " + this.claim_num)

		this.claim.withdrawn = true
	
		const { vars } = await this.alice.readAAStateVars(this.export_aa)
		console.log('vars', vars)
		expect(vars[this.claim_num + '_yes_by_' + this.aliceAddress]).to.be.undefined
		expect(vars[this.claim_num + '_no_by_' + this.assistant_aa]).to.be.eq(0.1 * this.amount)
		expect(vars['o_' + this.claim_num]).to.be.undefined
		expect(vars['f_' + this.claim_num]).to.deep.equalInAnyOrder(this.claim)

		const { unitObj } = await this.alice.getUnitInfo({ unit: response.response_unit })
		expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
			{
				address: this.aliceAddress,
				amount: Math.floor(2.1 * this.amount),
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
		let assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
		assistant_balance += 0.1 * this.amount   // balance in work
		this.mf += assistant_balance * this.management_fee * 14 / 24 / 360 // fractional
		this.profit -= 0.1 * this.amount

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.assistant_aa,
			amount: 1e4,
			data: {
				loss: 1,
				claim_num: this.claim_num,
			},
		})
		console.log(unit, error)

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	await this.network.witnessUntilStable(response.response_unit)

		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq("recorded a loss in claim " + this.claim_num)
		expect(response.response.responseVars.lost_amount).to.be.eq(0.1 * this.amount)

		const { vars: assistant_vars } = await this.manager.readAAStateVars(this.assistant_aa)
		expect(assistant_vars.profit).to.be.eq(this.profit)
		expect(round(assistant_vars.mf, 13)).to.be.eq(round(this.mf, 13))
		expect(assistant_vars.ts).to.be.eq(response.timestamp)
		expect(assistant_vars.shares_supply).to.be.eq(this.shares_supply)
		expect(assistant_vars.balance_in_work).to.be.eq(0)
		expect(assistant_vars['claim_' + this.claim_num]).to.be.undefined
	})



	after(async () => {
		// uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
