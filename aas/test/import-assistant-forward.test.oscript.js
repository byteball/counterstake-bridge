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
      .with.agent({ import_assistant_forward_factory: path.join(__dirname, '../import-assistant-forward-factory.oscript') })
      .with.agent({ import_assistant_forward: path.join(__dirname, '../import-assistant-forward.oscript') })
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

    this.getStake = amount => Math.ceil(amount / 1e8 * 600 / 20 * 1e9 * this.ratio)

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
      this.mf.stake += (assistant_balance.base.total + stake_balance_in_work) * this.management_fee * days / 360
      this.mf.image += (image_balance + image_balance_in_work) * this.management_fee * days / 360
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
    this.txts = Math.floor((await this.bob.getTime()).time / 1000)
    this.stake_amount = Math.ceil(this.amount / 1e8 * 600 / 20 * 1e9 * this.ratio)
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
    const { time_error } = await this.network.timetravel({ shift: '14h' })
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

  it('Alice create forward', async () => {
    const { unit, error } = await this.alice.triggerAaWithData({
      toAddress: this.network.agent.import_assistant_forward_factory,
      amount: 1e4,
      data: {
        create: 1,
        assistant: this.assistant_aa
      },
    })

    expect(error).to.be.null
    expect(unit).to.be.validUnit

    const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
    expect(response.response.error).to.be.undefined
    expect(response.bounced).to.be.false
    expect(response.response_unit).to.be.validUnit
 
    this.forward_aa = response.response.responseVars.forward;
    expect(this.forward_aa).to.be.validAddress

    const { vars } = await this.alice.readAAStateVars(this.network.agent.import_assistant_forward_factory)
    expect(vars['forward_aa_' + this.assistant_aa]).to.deep.equalInAnyOrder(this.forward_aa)
  })

  it("Bob invests in assistant shares using forward AA", async () => {
    await this.updateMF(0, 0, 14 / 24)

    const assistant_balance = (await this.manager.getOutputsBalanceOf(this.assistant_aa)).base.total
    const stake_amount = 300e9
    const image_amount = 10e8
    this.shares_supply = Math.floor(Math.sqrt((stake_amount + assistant_balance) * image_amount))
    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.forward_aa, amount: stake_amount + 1e4}],
        [this.asset]: [{ address: this.forward_aa, amount: image_amount }],
      },
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null
    expect(unit).to.be.validUnit

    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    await this.network.witnessUntilStable(response.response_unit)

    expect(response.response.error).to.be.undefined
    expect(response.bounced).to.be.false
    expect(response.response_unit).to.be.validUnit

    const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.bob, response.response_unit)
    expect(response2.response.error).to.be.undefined
    expect(response2.bounced).to.be.false
    expect(response2.response_unit).to.be.validUnit
    this.mf.ts = response2.timestamp

    const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
    expect(vars.stake_profit).to.be.eq(0)
    expect(vars.image_profit).to.be.eq(0)
    expect(roundObj(vars.mf, 14)).to.be.deep.eq(roundObj(this.mf, 14))
    expect(vars.shares_supply).to.be.eq(this.shares_supply)

    const { unitObj } = await this.bob.getUnitInfo({ unit: response2.response_unit })
    expect(Utils.getExternalPayments(unitObj)).to.deep.equalInAnyOrder([
      {
        asset: this.shares_asset,
        address: this.forward_aa,
        amount: this.shares_supply,
      },
    ])

    const { response: response3 } = await this.network.getAaResponseToUnitOnNode(this.bob, response2.response_unit)
    expect(response3.response.error).to.be.undefined
    expect(response3.bounced).to.be.false
    expect(response3.response_unit).to.be.validUnit

    const { unitObj: unitObj2 } = await this.bob.getUnitInfo({ unit: response3.response_unit })
    expect(Utils.getExternalPayments(unitObj2)).to.deep.equalInAnyOrder([
      {
        asset: this.shares_asset,
        address: this.bobAddress,
        amount: this.shares_supply,
      },
    ])

    const bob_balance = await this.bob.getOutputsBalanceOf(this.bobAddress);
    const bob_shares_balance = bob_balance[this.shares_asset].total

    expect(bob_shares_balance).to.be.eq(this.shares_supply)
  })

  after(async () => {
    // uncomment this line to pause test execution to get time for Obyte DAG explorer inspection
    //	await Utils.sleep(3600 * 1000)
    await this.network.stop()
  })
})
