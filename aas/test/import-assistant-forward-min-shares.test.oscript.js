// Regression test: the min_shares_amount guard added in 999ea84 must also protect users who buy
// assistant shares through import-assistant-forward.oscript.
//
// The forward AA builds the data message it sends on to the assistant, so unless it passes
// min_shares_amount through, trigger.data.min_shares_amount is always falsy inside the assistant
// and the require() at import-assistant.oscript:499-500 never runs -- the buy would execute
// unprotected, with no bounce and no error, while the user believes they set a floor.
//
// Cases covered:
//   1. forwarded payload actually carries the floor
//   2. unsatisfiable floor via the forward AA bounces, exactly like the direct path
//   3. satisfiable floor via the forward AA still succeeds
//   4. no floor at all still succeeds (unchanged behaviour for existing callers)

const { expect } = require('chai')
const path = require('path')

describe('Forward assistant AA honours min_shares_amount', function () {
  this.timeout(240000)

  before(async () => {
    this.network = await Network.create()
      .with.numberOfWitnesses(1)
      .with.asset({ ousd: {} })
      .with.agent({ import_base: path.join(__dirname, '../import.oscript') })
      .with.agent({ import_governance_base: path.join(__dirname, '../import-governance.oscript') })
      .with.agent({ import_factory: path.join(__dirname, '../import-factory.oscript') })
      .with.agent({ ia_base: path.join(__dirname, '../import-assistant.oscript') })
      .with.agent({ import_assistant_factory: path.join(__dirname, '../import-assistant-factory.oscript') })
      .with.agent({ import_assistant_forward: path.join(__dirname, '../import-assistant-forward.oscript') })
      .with.agent({ assistant_governance_base: path.join(__dirname, '../assistant-governance.oscript') })
      .with.wallet({ alice: 10000e9 })
      .with.wallet({ bob: 10000e9 })
      .with.wallet({ manager: 100e9 })
      .with.wallet({ oracle: 1e9 })
      .run()

    this.oracle = this.network.wallet.oracle
    this.oracleAddress = await this.oracle.getAddress()
    this.alice = this.network.wallet.alice
    this.aliceAddress = await this.alice.getAddress()
    this.bob = this.network.wallet.bob
    this.bobAddress = await this.bob.getAddress()
    this.manager = this.network.wallet.manager
    this.managerAddress = await this.manager.getAddress()
  })

  it('Oracle posts a data feed', async () => {
    const { unit, error } = await this.oracle.sendMulti({
      messages: [{ app: 'data_feed', payload: { GBYTE_USD: 20, ETH_USD: 600 } }],
    })
    expect(error).to.be.null
    expect(unit).to.be.validUnit
    await this.network.witnessUntilStable(unit)
  })

  it('Bob defines a new import bridge', async () => {
    const { error: tf_error } = await this.network.timefreeze()
    expect(tf_error).to.be.null

    this.stake_asset = 'base'
    this.ratio = 1.05

    const { unit, error } = await this.bob.triggerAaWithData({
      toAddress: this.network.agent.import_factory,
      amount: 10000,
      data: {
        stake_asset: this.stake_asset,
        home_asset: '0x000000000',
        home_network: 'eth_net_id',
        challenging_periods: '14 72 240 820',
        stake_asset_decimals: 9,
        asset_decimals: 8,
        ratio: this.ratio,
        counterstake_coef: 1.5,
        large_threshold: 10000e9,
        oracles: this.oracleAddress + '*ETH_USD ' + this.oracleAddress + '/GBYTE_USD',
      },
    })
    expect(error).to.be.null
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    expect(response.bounced).to.be.false

    this.import_aa = response.response.responseVars['address']
    const { vars: import_vars } = await this.bob.readAAStateVars(this.import_aa)
    this.asset = import_vars['asset']
  })

  it('Bob defines a new import assistant', async () => {
    const { unit, error } = await this.bob.triggerAaWithData({
      toAddress: this.network.agent.import_assistant_factory,
      amount: 10000,
      data: {
        bridge_aa: this.import_aa,
        manager: this.managerAddress,
        management_fee: 0.01,
        success_fee: 0.2,
      },
    })
    expect(error).to.be.null
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    expect(response.bounced).to.be.false

    this.assistant_aa = response.response.responseVars.address
    const { vars: assistant_vars } = await this.bob.readAAStateVars(this.assistant_aa)
    this.shares_asset = assistant_vars['shares_asset']
    expect(this.shares_asset).to.be.validUnit
  })

  it('Bob claims coins on the bridge to obtain the image asset', async () => {
    this.amount = 50e8
    const txts = Math.floor((await this.bob.getTime()).time / 1000)
    const stake_amount = Math.ceil(this.amount / 1e8 * 600 / 20 * 1e9 * this.ratio)

    const { unit, error } = await this.bob.triggerAaWithData({
      toAddress: this.import_aa,
      amount: stake_amount + 2000,
      data: {
        txid: '0x888dead333beef',
        txts: txts,
        amount: this.amount,
        sender_address: '0xA7a2448D91AA5E09b217D94AA78bB1c7A8dAE01f',
      },
    })
    expect(error).to.be.null
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    expect(response.bounced).to.be.false
    this.claim_num = 1
  })

  it('Bob withdraws the claim', async () => {
    const { time_error } = await this.network.timetravel({ shift: '14h' })
    expect(time_error).to.be.undefined

    const { unit, error } = await this.bob.triggerAaWithData({
      toAddress: this.import_aa,
      amount: 1e4,
      data: { withdraw: 1, claim_num: this.claim_num },
    })
    expect(error).to.be.null
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    await this.network.witnessUntilStable(response.response_unit)
    expect(response.bounced).to.be.false

    const bob_balance = await this.bob.getOutputsBalanceOf(this.bobAddress)
    expect(bob_balance[this.asset].total).to.be.gte(this.amount)
  })

  // import-assistant-forward-factory.oscript pins mainnet addresses, so it cannot be used on a test
  // network. Deploy the instance directly with exactly the definition the factory would produce.
  it('Alice deploys a forward AA instance', async () => {
    const { address, unit, error } = await this.alice.deployAgent([
      'autonomous agent',
      {
        base_aa: this.network.agent.import_assistant_forward,
        params: { assistant: this.assistant_aa },
      },
    ])
    expect(error).to.be.null
    expect(address).to.be.validAddress
    expect(unit).to.be.validUnit
    await this.network.witnessUntilStable(unit)
    this.forward_aa = address
  })

  it('Bob seeds the pool with an initial share purchase', async () => {
    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.assistant_aa, amount: 300e9 }],
        [this.asset]: [{ address: this.assistant_aa, amount: 10e8 }],
      },
      messages: [{ app: 'data', payload: { buy_shares: 1 } }],
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    await this.network.witnessUntilStable(response.response_unit)
    expect(response.bounced).to.be.false

    const { vars } = await this.bob.readAAStateVars(this.assistant_aa)
    this.shares_supply = vars.shares_supply
    expect(this.shares_supply).to.be.gt(0)

    // Orders of magnitude more shares than a buy of this size could ever mint.
    this.IMPOSSIBLE_MIN = 1e15
    expect(this.IMPOSSIBLE_MIN).to.be.gt(this.shares_supply * 1000)
  })

  it('an unsatisfiable min_shares_amount bounces on the direct path', async () => {
    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.assistant_aa, amount: 100e9 }],
        [this.asset]: [{ address: this.assistant_aa, amount: 5e8 }],
      },
      messages: [{
        app: 'data',
        payload: { buy_shares: 1, min_shares_amount: this.IMPOSSIBLE_MIN },
      }],
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null

    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    await this.network.witnessUntilStable(response.response_unit)
    expect(response.bounced).to.be.true
    expect(JSON.stringify(response.response.error)).to.match(/would be less than min/)
  })

  it('the forward AA passes min_shares_amount on to the assistant', async () => {
    const shares_before = await this.getShares()

    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.forward_aa, amount: 100e9 + 1e4 }],
        [this.asset]: [{ address: this.forward_aa, amount: 5e8 }],
      },
      messages: [{
        app: 'data',
        payload: { buy_shares: 1, min_shares_amount: this.IMPOSSIBLE_MIN },
      }],
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null

    // The assistant is a secondary AA here, so its bounce reverts the whole chain and Bob's
    // trigger bounces -- the same protection the direct path gives.
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    expect(response.bounced).to.be.true
    expect(JSON.stringify(response.response.error)).to.match(/would be less than min/)

    expect(await this.getShares()).to.be.eq(shares_before)
  })

  it('a satisfiable min_shares_amount still succeeds through the forward AA', async () => {
    const shares_before = await this.getShares()

    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.forward_aa, amount: 100e9 + 1e4 }],
        [this.asset]: [{ address: this.forward_aa, amount: 5e8 }],
      },
      messages: [{ app: 'data', payload: { buy_shares: 1, min_shares_amount: 1 } }],
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null

    const minted = await this.settleForwardBuy(unit, shares_before)
    expect(minted).to.be.gte(1)
  })

  it('omitting min_shares_amount still succeeds through the forward AA', async () => {
    const shares_before = await this.getShares()

    const { unit, error } = await this.bob.sendMulti({
      outputs_by_asset: {
        base: [{ address: this.forward_aa, amount: 100e9 + 1e4 }],
        [this.asset]: [{ address: this.forward_aa, amount: 5e8 }],
      },
      messages: [{ app: 'data', payload: { buy_shares: 1 } }],
      spend_unconfirmed: 'all',
    })
    expect(error).to.be.null

    const minted = await this.settleForwardBuy(unit, shares_before)
    expect(minted).to.be.gt(0)
  })

  after(async () => {
    if (this.network) await this.network.stop()
  })

  // --- helpers ---

  this.getShares = async () => {
    const balance = await this.bob.getOutputsBalanceOf(this.bobAddress)
    return balance[this.shares_asset] ? balance[this.shares_asset].total : 0
  }

  // Walks the three hops of a successful forward buy: Bob -> forward -> assistant -> forward -> Bob,
  // and returns how many shares Bob gained.
  this.settleForwardBuy = async (unit, shares_before) => {
    const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
    expect(response.bounced).to.be.false

    const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
    const data = unitObj.messages.find(m => m.app === 'data').payload
    expect(data.buy_shares).to.be.eq(1)

    const { response: response2 } = await this.network.getAaResponseToUnitOnNode(this.bob, response.response_unit)
    expect(response2.bounced).to.be.false

    const { response: response3 } = await this.network.getAaResponseToUnitOnNode(this.bob, response2.response_unit)
    expect(response3.bounced).to.be.false
    await this.network.witnessUntilStable(response3.response_unit)

    return (await this.getShares()) - shares_before
  }
})
