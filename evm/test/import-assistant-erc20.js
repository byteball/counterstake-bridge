require('@openzeppelin/test-helpers/configure')({
	provider: 'http://localhost:7545',
});

const Import = artifacts.require("Import");
const Oracle = artifacts.require("Oracle");
const Token = artifacts.require("Token");
const Governance = artifacts.require("Governance");
const VotedValueUint = artifacts.require("VotedValueUint");
const VotedValueUintArray = artifacts.require("VotedValueUintArray");
const CounterstakeFactory = artifacts.require("CounterstakeFactory");
const AssistantFactory = artifacts.require("AssistantFactory");
const ImportAssistant = artifacts.require("ImportAssistant");
const { BN, balance, ether, expectEvent, expectRevert, time, constants } = require('@openzeppelin/test-helpers');

const chai = require('chai');

const expect = chai.expect;

function bn2string(in_obj) {
	let obj = Array.isArray(in_obj) ? [] : {};
	for (let key in in_obj) {
		const v = in_obj[key];
		obj[key] = BN.isBN(v) ? v.toString() : v;
	}
	return obj;
}

function removeNumericKeys(obj) {
	let new_obj = {};
	for (let key in obj) {
		if (!key.match(/^\d+$/))
			new_obj[key] = obj[key];
	}
	return new_obj;
}


const bn0 = new BN(0);
const bn1 = new BN(1);
const no = bn0;
const yes = bn1;
const a0 = constants.ZERO_ADDRESS;


const year = new BN(360).mul(new BN(24)).mul(new BN(3600));

contract("Importing GBYTE with USDC staking and assistance", async accounts => {
	const aliceAccount = accounts[0]
	const bobAccount = accounts[1]
	const charlieAccount = accounts[2]
	const managerAccount = accounts[3]

	let instance, governance, ratioVotedValue, counterstakeCoefVotedValue, largeThresholdVotedValue, challengingPeriodsVotedValue, largeChallengingPeriodsVotedValue, assistant;
	let token;
	
	before(async () => {
		const factory = await CounterstakeFactory.deployed();
		console.log('Factory address', factory.address);

		const oracle = await Oracle.new();
		console.log('oracle address', oracle.address);
		await oracle.setPrice("Obyte", "USDC", new BN(30), new BN(1), { from: aliceAccount });
		const { num, den } = await oracle.getPrice("Obyte", "USDC", { from: bobAccount });
		expect(num).to.be.bignumber.equal(new BN(30))
		expect(den).to.be.bignumber.equal(new BN(1))

		token = await Token.new("USDC stake token", "USDC");
		console.log('USDC token address', token.address);

		await token.mint(aliceAccount, ether('4000'), { from: bobAccount });
		expect(await token.balanceOf(aliceAccount)).to.be.bignumber.equal(ether('4000'));

		await token.mint(bobAccount, ether('15000'), { from: bobAccount });
		expect(await token.balanceOf(bobAccount)).to.be.bignumber.equal(ether('15000'));

		await token.mint(charlieAccount, ether('10000'), { from: bobAccount });
		expect(await token.balanceOf(charlieAccount)).to.be.bignumber.equal(ether('10000'));

		let res = await debug(factory.createImport("Obyte", "base", "Imported GBYTE", "GBYTE", token.address, oracle.address, 150, 100, ether('10000'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]));
		console.log('create result', res)
		instance = await Import.at(res.logs[0].args.contractAddress);
		console.log('GBYTE import address', instance.address);

		await token.approve(instance.address, ether('8000'), { from: aliceAccount });
		expect(await token.allowance(aliceAccount, instance.address)).to.be.bignumber.equal(ether('8000'));

		await token.approve(instance.address, ether('6000'), { from: bobAccount });
		expect(await token.allowance(bobAccount, instance.address)).to.be.bignumber.equal(ether('6000'));

		await token.approve(instance.address, ether('5000'), { from: charlieAccount });
		expect(await token.allowance(charlieAccount, instance.address)).to.be.bignumber.equal(ether('5000'));

		// shortcuts for overloaded functions
		instance.challengeById = instance.methods['challenge(string,uint8,uint256)'];
		instance.challengeByNum = instance.methods['challenge(uint256,uint8,uint256)'];
		instance.getClaimById = instance.methods['getClaim(string)'];
		instance.getClaimByNum = instance.methods['getClaim(uint256)'];
		instance.withdrawById = instance.methods['withdraw(string)'];
		instance.withdrawByNum = instance.methods['withdraw(uint256)'];
		instance.withdrawTo = instance.methods['withdraw(string,address)'];

		governance = await Governance.at(await instance.governance());
		console.log('governance address', governance.address);
		expect(await governance.votingTokenAddress()).to.be.equal(token.address);
		expect(await governance.governedContractAddress()).to.be.equal(instance.address);

		ratioVotedValue = await VotedValueUint.at(await governance.votedValuesMap('ratio100'));
		console.log('ratio100 voted value address', ratioVotedValue.address);

		counterstakeCoefVotedValue = await VotedValueUint.at(await governance.votedValuesMap('counterstake_coef100'));
		console.log('counterstake_coef100 voted value address', counterstakeCoefVotedValue.address);

		largeThresholdVotedValue = await VotedValueUint.at(await governance.votedValuesMap('large_threshold'));
		console.log('large_threshold voted value address', largeThresholdVotedValue.address);

		challengingPeriodsVotedValue = await VotedValueUintArray.at(await governance.votedValuesMap('challenging_periods'));
		console.log('challenging_periods voted value address', challengingPeriodsVotedValue.address);

		largeChallengingPeriodsVotedValue = await VotedValueUintArray.at(await governance.votedValuesMap('large_challenging_periods'));
		console.log('large_challenging_periods voted value address', largeChallengingPeriodsVotedValue.address);

		governance.withdrawAll = governance.methods['withdraw()'];
		governance.withdrawAmount = governance.methods['withdraw(uint256)'];

		// assistant
		const assistantFactory = await AssistantFactory.deployed();
		console.log('assistant factory address', assistantFactory.address);

		let assistant_res = await assistantFactory.createImportAssistant(instance.address, managerAccount, 100, 2500, 30, 1, "GBYTE-to-Ethereum import assistant", "GBA");
		assistant = await ImportAssistant.at(assistant_res.logs[0].args.contractAddress);
		console.log('GBYTE-to-Ethereum import assistant address', assistant.address);

		await instance.approve(assistant.address, ether('800'), { from: aliceAccount });
		expect(await instance.allowance(aliceAccount, assistant.address)).to.be.bignumber.equal(ether('800'));

		await instance.approve(assistant.address, ether('600'), { from: bobAccount });
		expect(await instance.allowance(bobAccount, assistant.address)).to.be.bignumber.equal(ether('600'));

		await instance.approve(assistant.address, ether('500'), { from: charlieAccount });
		expect(await instance.allowance(charlieAccount, assistant.address)).to.be.bignumber.equal(ether('500'));


		await token.approve(assistant.address, ether('8000'), { from: aliceAccount });
		expect(await token.allowance(aliceAccount, assistant.address)).to.be.bignumber.equal(ether('8000'));

		await token.approve(assistant.address, ether('6000'), { from: bobAccount });
		expect(await token.allowance(bobAccount, assistant.address)).to.be.bignumber.equal(ether('6000'));

		await token.approve(assistant.address, ether('5000'), { from: charlieAccount });
		expect(await token.allowance(charlieAccount, assistant.address)).to.be.bignumber.equal(ether('5000'));

	});

	it("the 1st claim", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('50')
		const stake = ether('1500')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		console.log('ts', ts)
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: bobAccount,
			claimant_address: bobAccount,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, bobAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(1)
		this.txts = txts;
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: bobAccount, sender_address, recipient_address: bobAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, bobAccount)).to.be.bignumber.equal(stake);
	});

	it("withdraw", async () => {
		await time.increase(12 * 3600 + 1);

		let balance_before = await token.balanceOf(bobAccount);
		console.log('balance before withdrawal', balance_before.toString())

		let res = await instance.withdrawById(this.claim_id, { from: bobAccount });
		console.log('withdraw res', res)

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance in stake asset
		let balance_after = await token.balanceOf(bobAccount);
		console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.add(ether('1500'))).to.be.bignumber.equal(balance_after);

		// check the balance in E-GBYTE
		expect(await instance.balanceOf(bobAccount)).to.be.bignumber.equal(ether('50'))

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, bobAccount)).to.be.bignumber.equal(bn0);
	});



	it("bob buys shares in the assistant", async () => {
		const usdc_amount = ether('1000')
		const gbyte_amount = ether('40')
		const shares_amount = ether('200')
		let res = await assistant.buyShares(usdc_amount, gbyte_amount, { from: bobAccount });
		expectEvent(res, 'Transfer', { from: a0, to: bobAccount, value: shares_amount });
		this.ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.stake_mf = bn0;
		this.image_mf = bn0;
		
		let assistant_bal = await token.balanceOf(assistant.address);
		expect(assistant_bal).to.be.bignumber.equal(usdc_amount);
		expect(await instance.balanceOf(assistant.address)).to.be.bignumber.equal(gbyte_amount);

		// bobs shares balance
		let bob_bal = await assistant.balanceOf(bobAccount);
		expect(bob_bal).to.be.bignumber.equal(shares_amount);
	});

	it("failed claim: not from manager", async () => {
		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		let promise = assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: bobAccount });
		await expectRevert(promise, "caller is not the manager");
	});

	it("start a claim", async () => {
		let balance_before = await instance.balanceOf(aliceAccount);
		console.log('balance before claim', balance_before.toString())

		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('5')
		const stake = ether('150')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.image_profit = amount.sub(paid_amount)
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: assistant.address,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(2)
		this.txts = txts
		this.claim = expected_claim;
	//	expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: assistant.address, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
	//	console.log('claim', claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(stake);

	//	this.stake_mf = ether('1000').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.image_mf = ether('40').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.ts = ts
		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(stake)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(paid_amount)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(stake)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(paid_amount)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await instance.balanceOf(aliceAccount);
		console.log('balance after claim', balance_after.toString())
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("failed claim: same txid again", async () => {
		const txid = 'transid';
		const amount = ether('5')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		let promise = assistant.claim(txid, this.txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		await expectRevert(promise, "this transfer has already been claimed");
	});

	it("failed challenge: same outcome", async () => {
		const stake = ether('4')
		let promise = assistant.challenge(this.claim_num, yes, stake, { from: managerAccount });
		await expectRevert(promise, "this outcome is already current");
	});

	it("failed challenge: nonexistent claim", async () => {
		const stake = ether('4')
		let promise = assistant.challenge(88, yes, stake, { from: managerAccount });
		await expectRevert(promise, "no such claim");
	});

	it("challenge", async () => {
		const stake = ether('50');
		const outcome = no;
		const res = await instance.challengeById(this.claim_id, outcome, stake, { from: charlieAccount });
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: charlieAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: stake, challenging_target: this.challenging_target });
		this.claim.no_stake = stake;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(stake);
		this.stake_profit = stake; // charlie will lose and his stake will become our profit
	});

	it("failed withdraw: too early", async () => {
		let promise = instance.withdrawTo(this.claim_id, assistant.address, { from: aliceAccount });
		await expectRevert(promise, "challenging period is still ongoing");
	});

	it("failed withdraw: non-owner", async () => {
		await time.increase(12 * 3600);
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});

	it("failed challenge: expired", async () => {
		const stake = ether('4')
		let promise = assistant.challenge(this.claim_num, no, stake, { from: managerAccount });
		await expectRevert(promise, "the challenging period has expired");
	});

	it("withdraw", async () => {
		let stake_balance_before = await token.balanceOf(assistant.address);
		console.log('balance before withdrawal', stake_balance_before.toString())
		let image_balance_before = await instance.balanceOf(assistant.address);

		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		console.log('withdraw res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let stake_balance_after = await token.balanceOf(assistant.address);
		console.log('balance after withdrawal', stake_balance_after.toString())
		expect(stake_balance_before.add(ether('200'))).to.be.bignumber.equal(stake_balance_after); // 150+50
		let image_balance_after = await instance.balanceOf(assistant.address);
		expect(image_balance_before.add(ether('5'))).to.be.bignumber.equal(image_balance_after);

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(ether('50'));

		const delta_stake_mf = ether('1000').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = ether('40').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts
		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});

	it("failed withdraw: already withdrawn", async () => {
		let promise = instance.withdrawTo(this.claim_id, assistant.address, { from: managerAccount });
		await expectRevert(promise, "already withdrawn");
	});





	it("alice claims some coins she didn't receive", async () => {
		const txid = 'transid2';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('10')
		const stake = ether('300')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: aliceAccount,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(3)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);

	});

	it("challenge by assistant, outcome changed", async () => {
		await time.increase(3600);
		let stake_balance_before = await token.balanceOf(assistant.address);
		let image_balance_before = await instance.balanceOf(assistant.address);

		const stake = ether('500'); // need 450 total, 50 excess
		const accepted_stake = ether('450')
		const outcome = no;
		const res = await assistant.challenge(this.claim_num, outcome, stake, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.expiry_ts = new BN(ts + 3 * 24 * 3600);
		this.claim.period_number = bn1;
		this.claim.current_outcome = no;
		this.claim.no_stake = this.claim.no_stake.add(accepted_stake); // 0.3 accepted, 4.7 excess
		this.challenging_target = this.challenging_target.mul(new BN(150)).div(new BN(100));
	//	expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: assistant.address, stake: accepted_stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(accepted_stake);

		// check the balance
		let balance_after = await token.balanceOf(assistant.address);
		expect(stake_balance_before.sub(accepted_stake)).to.be.bignumber.equal(balance_after);

		const delta_stake_mf = stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		this.stake_balance_in_work = accepted_stake

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(accepted_stake)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(accepted_stake)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});

	it("failed withdraw by alice: you lost", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let promise = instance.withdrawById(this.claim_id, { from: aliceAccount });
		await expectRevert(promise, "you are not the recipient and you didn't stake on the winning outcome or you have already withdrawn");
	});

	it("alice trigers a loss and fails because the assistant has a winning stake", async () => {
		let promise = assistant.recordLoss(this.claim_num, { from: aliceAccount });
		await expectRevert(promise, "have a winning stake in this claim");
	});

	it("withdraw to assistant", async () => {
		let stake_balance_before = await token.balanceOf(assistant.address);
		let image_balance_before = await instance.balanceOf(assistant.address);

		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		console.log('withdraw res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await token.balanceOf(assistant.address);
		expect(stake_balance_before.add(ether('300')).add(ether('450'))).to.be.bignumber.equal(balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(ether('300'));
		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(bn0);

		const delta_stake_mf = stake_balance_before.add(this.stake_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts
		this.stake_profit = this.stake_profit.add(ether('300'));

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});

	it("alice trigers a loss and fails because there is no loss to the assistant", async () => {
		let promise = assistant.recordLoss(this.claim_num, { from: aliceAccount });
		await expectRevert(promise, "this claim is already accounted for");
	});

	it("bob redeems some shares", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let bob_stake_balance_before = await token.balanceOf(bobAccount);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let bob_image_balance_before = await instance.balanceOf(bobAccount)

		const shares_amount = ether('60')

		const res = await assistant.redeemShares(shares_amount, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		let bob_stake_balance_after = await token.balanceOf(bobAccount);
		let assistant_image_balance_after = await instance.balanceOf(assistant.address)
		let bob_image_balance_after = await instance.balanceOf(bobAccount)

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		const stake_sf = this.stake_profit.mul(new BN(25)).div(new BN(100))
		const image_sf = this.image_profit.mul(new BN(25)).div(new BN(100))
		const stake_net_balance = assistant_stake_balance_before.sub(this.stake_mf).sub(stake_sf)
		const image_net_balance = assistant_image_balance_before.sub(this.image_mf).sub(image_sf)
		let stake_payout = stake_net_balance.mul(shares_amount).div(ether('200'))
		let image_payout = image_net_balance.mul(shares_amount).div(ether('200'))
		stake_payout = stake_payout.sub(stake_payout.mul(new BN(30)).div(new BN(10000)))
		image_payout = image_payout.sub(image_payout.mul(new BN(30)).div(new BN(10000)))
		expect(assistant_stake_balance_before.sub(stake_payout)).to.be.bignumber.eq(assistant_stake_balance_after)
		expect(assistant_image_balance_before.sub(image_payout)).to.be.bignumber.eq(assistant_image_balance_after)
		expect(bob_stake_balance_before.add(stake_payout)).to.be.bignumber.eq(bob_stake_balance_after)
		expect(bob_image_balance_before.add(image_payout)).to.be.bignumber.eq(bob_image_balance_after)
		expect(await assistant.balanceOf(bobAccount)).to.be.bignumber.eq(ether('140'))

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	

	it("alice buys some shares", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let alice_image_balance_before = await instance.balanceOf(aliceAccount)

		const gbyte_amount = ether('4')
		const usdc_amount = ether('120')

		const res = await assistant.buyShares(usdc_amount, gbyte_amount, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		const stake_sf = this.stake_profit.mul(new BN(25)).div(new BN(100))
		const image_sf = this.image_profit.mul(new BN(25)).div(new BN(100))
		const stake_net_balance = assistant_stake_balance_before.sub(this.stake_mf).sub(stake_sf)
		const image_net_balance = assistant_image_balance_before.sub(this.image_mf).sub(image_sf)

		const new_stake_balance = stake_net_balance.add(usdc_amount)
		const new_image_balance = image_net_balance.add(gbyte_amount)
		const s1 = parseFloat(new_stake_balance.mul(new_image_balance).toString())
		const s2 = parseFloat(stake_net_balance.mul(image_net_balance).toString())
		const coef = Math.sqrt(s1 / s2)
		const fShares = 140e18 * (coef - 1)
		const shares_amount = new BN(fShares.toFixed())
		expect(await assistant.balanceOf(aliceAccount)).to.be.bignumber.closeTo(shares_amount, '1000000')
		expect(await instance.balanceOf(aliceAccount)).to.be.bignumber.eq(alice_image_balance_before.sub(gbyte_amount))

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	

	it("manager withdraws his management fee", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let manager_stake_balance_before = await token.balanceOf(managerAccount);
		let manager_image_balance_before = await instance.balanceOf(managerAccount)

		const res = await assistant.withdrawManagementFee({ from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		let manager_stake_balance_after = await token.balanceOf(managerAccount);
		let manager_image_balance_after = await instance.balanceOf(managerAccount)
		expect(assistant_stake_balance_before.sub(this.stake_mf)).to.be.bignumber.eq(assistant_stake_balance_after)
		expect(manager_stake_balance_before.add(this.stake_mf)).to.be.bignumber.eq(manager_stake_balance_after)
		expect(manager_image_balance_before.add(this.image_mf)).to.be.bignumber.eq(manager_image_balance_after)
		this.stake_mf = bn0
		this.image_mf = bn0

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});

	it("manager withdraws his success fee", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let manager_stake_balance_before = await token.balanceOf(managerAccount);
		let manager_image_balance_before = await instance.balanceOf(managerAccount)

		const res = await assistant.withdrawSuccessFee({ from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		const stake_sf = this.stake_profit.mul(new BN(25)).div(new BN(100))
		const image_sf = this.image_profit.mul(new BN(25)).div(new BN(100))

		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		let manager_stake_balance_after = await token.balanceOf(managerAccount);
		let manager_image_balance_after = await instance.balanceOf(managerAccount)
		expect(assistant_stake_balance_before.sub(stake_sf)).to.be.bignumber.eq(assistant_stake_balance_after)
		expect(manager_stake_balance_before.add(stake_sf)).to.be.bignumber.eq(manager_stake_balance_after)
		expect(manager_image_balance_before.add(image_sf)).to.be.bignumber.eq(manager_image_balance_after)
		this.stake_profit = bn0
		this.image_profit = bn0

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(bn0)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(bn0)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	



	it("claim 3", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let balance_before = await instance.balanceOf(aliceAccount);
		console.log('balance before claim', balance_before.toString())

		const txid = 'transid3';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('12')
		const stake = ether('360')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.paid_amount = paid_amount
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: assistant.address,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(4)
		this.txts = txts
		this.claim = expected_claim;
	//	expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: assistant.address, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(stake);

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		this.stake_balance_in_work = stake
		this.image_balance_in_work = paid_amount

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await instance.balanceOf(aliceAccount);
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("Manager challenges his own claim and overturns the outcome", async () => {
		await time.increase(3600);
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)

		const stake = bn0;
		const accepted_stake = ether('540')
		const outcome = no;
		const res = await assistant.challenge(this.claim_num, outcome, stake, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.expiry_ts = new BN(ts + 3 * 24 * 3600);
		this.claim.period_number = bn1;
		this.claim.current_outcome = no;
		this.claim.no_stake = this.claim.no_stake.add(accepted_stake);
		this.challenging_target = this.challenging_target.mul(new BN(150)).div(new BN(100));
	//	expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: assistant.address, stake: accepted_stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(accepted_stake);
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('360'));

		// check the balance
		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		expect(assistant_stake_balance_before.sub(accepted_stake)).to.be.bignumber.equal(assistant_stake_balance_after);

		const delta_stake_mf = assistant_stake_balance_before.add(this.stake_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.add(this.image_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		this.stake_balance_in_work = this.stake_balance_in_work.add(accepted_stake)

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});

	it("withdraw to assistant", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)

		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		expect(assistant_stake_balance_before.add(ether('360')).add(ether('540'))).to.be.bignumber.equal(assistant_stake_balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('360'));
		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(bn0);

		const delta_stake_mf = assistant_stake_balance_before.add(this.stake_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.add(this.image_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts
		this.image_profit = bn0.sub(this.paid_amount);

		this.stake_balance_in_work = bn0
		this.image_balance_in_work = bn0

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});



	it("claim 4", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let balance_before = await instance.balanceOf(aliceAccount);
		console.log('balance before claim', balance_before.toString())

		const txid = 'transid4';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('1')
		const stake = ether('30')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.paid_amount = paid_amount
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: assistant.address,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(5)
		this.txts = txts
		this.claim = expected_claim;
	//	expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: assistant.address, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(stake);

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		this.stake_balance_in_work = stake
		this.image_balance_in_work = paid_amount

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await instance.balanceOf(aliceAccount);
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("bob challenges the claim and overturns the outcome", async () => {
		await time.increase(3600);

		const stake = ether('45');
		const outcome = no;
		const res = await instance.challengeById(this.claim_id, outcome, stake, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.expiry_ts = new BN(ts + 3 * 24 * 3600);
		this.claim.period_number = bn1;
		this.claim.current_outcome = no;
		this.claim.no_stake = this.claim.no_stake.add(stake);
		this.challenging_target = this.challenging_target.mul(new BN(150)).div(new BN(100));
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: bobAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(stake);
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('30'));

	});

	it("withdraw to bob", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let balance_before = await token.balanceOf(bobAccount);

		let res = await instance.withdrawById(this.claim_id, { from: bobAccount });
		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await token.balanceOf(bobAccount);
		expect(balance_before.add(ether('75'))).to.be.bignumber.equal(balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('30'));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(bn0);

	});

	it("record the loss", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)

		let res = await assistant.recordLoss(this.claim_num, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.add(this.stake_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.add(this.image_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		this.stake_profit = this.stake_profit.sub(this.stake_balance_in_work)
		this.image_profit = this.image_profit.sub(this.image_balance_in_work)
		this.stake_balance_in_work = bn0
		this.image_balance_in_work = bn0

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		
	});



	it("claim 5: alice claims some coins", async () => {
		const txid = 'transid5';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('2')
		const stake = ether('60')
		const sender_address = "SENDER"
		const data = '{"max_fee":1}'
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		const expiry_ts = ts + 12 * 3600;
		const expected_claim = {
			amount: amount,
		//	reward,
			recipient_address: aliceAccount,
			claimant_address: aliceAccount,
			sender_address,
			data,
		//	txid,
			txts: new BN(txts),
			yes_stake: stake,
			no_stake: ether('0'),
			current_outcome: yes,
			is_large: false,
			period_number: bn0,
			ts: new BN(ts),
			expiry_ts: new BN(expiry_ts),
		//	challenging_target: stake.mul(new BN(150)).div(new BN(100)),
			withdrawn: false,
			finished: false,
		};
		this.challenging_target = stake.mul(new BN(150)).div(new BN(100));
		const claim_id = [sender_address, aliceAccount.substr(2).toLowerCase(), txid, txts, amount.toString(), reward.toString(), data].join('_');
		this.claim_id = claim_id;
		this.claim_num = new BN(6)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);

	});

	it("challenge by assistant, outcome unchanged", async () => {
		await time.increase(3600);
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)

		const stake = ether('10');
		const outcome = no;
		const res = await assistant.challenge(this.claim_num, outcome, stake, { from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.no_stake = this.claim.no_stake.add(stake);
	//	expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: assistant.address, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(stake);

		// check the balance
		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		expect(assistant_stake_balance_before.sub(stake)).to.be.bignumber.equal(assistant_stake_balance_after);

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		this.stake_balance_in_work = stake

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});


	it("withdraw to alice", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let stake_balance_before = await token.balanceOf(aliceAccount);
		let image_balance_before = await instance.balanceOf(aliceAccount);

		let res = await instance.withdrawById(this.claim_id, { from: aliceAccount });
		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let stake_balance_after = await token.balanceOf(aliceAccount);
		let image_balance_after = await instance.balanceOf(aliceAccount);
		expect(stake_balance_before.add(ether('70'))).to.be.bignumber.equal(stake_balance_after);
		expect(image_balance_before.add(ether('2'))).to.be.bignumber.eq(image_balance_after)

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(ether('10'));
		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(bn0);

	});


	it("record the loss", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)

		let res = await assistant.recordLoss(this.claim_num, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.add(this.stake_balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.stake_mf = this.stake_mf.add(delta_stake_mf)
		this.image_mf = this.image_mf.add(delta_image_mf)
		this.ts = ts

		this.stake_profit = this.stake_profit.sub(this.stake_balance_in_work)
		this.stake_balance_in_work = bn0

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balances_in_work(this.claim_num))[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		
	});

	it("swap USDC to GBYTE", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let alice_image_balance_before = await instance.balanceOf(aliceAccount)

		const amount = ether('50')

		let res = await assistant.swapStake2Image(amount, 0, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const stake_mf = this.stake_mf.add(delta_stake_mf)
		const image_mf = this.image_mf.add(delta_image_mf)
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		const stake_sf = this.stake_profit.mul(new BN(25)).div(new BN(100))
		const image_sf = this.image_profit.mul(new BN(25)).div(new BN(100))
		expect(stake_sf).to.be.bignumber.lt(bn0)
		expect(image_sf).to.be.bignumber.lt(bn0)

		const net_stake_balance = assistant_stake_balance_before.sub(stake_mf)
		const net_image_balance = assistant_image_balance_before.sub(image_mf)
		let out_amount = amount.mul(net_image_balance).div(net_stake_balance.add(amount))
		out_amount = out_amount.sub(out_amount.mul(new BN(30)).div(new BN(10000)))

		let assistant_stake_balance_after = await token.balanceOf(assistant.address);
		let alice_image_balance_after = await instance.balanceOf(aliceAccount)
		expect(assistant_stake_balance_before.add(amount)).to.be.bignumber.eq(assistant_stake_balance_after)
		expect(alice_image_balance_before.add(out_amount)).to.be.bignumber.eq(alice_image_balance_after)

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	})

	it("swap GBYTE to USDC", async () => {
		let assistant_stake_balance_before = await token.balanceOf(assistant.address);
		let assistant_image_balance_before = await instance.balanceOf(assistant.address)
		let alice_stake_balance_before = await token.balanceOf(aliceAccount)

		const amount = ether('2')

		let res = await assistant.swapImage2Stake(amount, 0, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_stake_mf = assistant_stake_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const delta_image_mf = assistant_image_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		const stake_mf = this.stake_mf.add(delta_stake_mf)
		const image_mf = this.image_mf.add(delta_image_mf)
	//	this.stake_mf = this.stake_mf.add(delta_stake_mf)
	//	this.image_mf = this.image_mf.add(delta_image_mf)
	//	this.ts = ts

		const net_stake_balance = assistant_stake_balance_before.sub(stake_mf)
		const net_image_balance = assistant_image_balance_before.sub(image_mf)
		let out_amount = amount.mul(net_stake_balance).div(net_image_balance.add(amount))
		out_amount = out_amount.sub(out_amount.mul(new BN(30)).div(new BN(10000)))

		let alice_stake_balance_after = await token.balanceOf(aliceAccount)
		expect(alice_stake_balance_before.add(out_amount)).to.be.bignumber.eq(alice_stake_balance_after)
		
		let assistant_image_balance_after = await instance.balanceOf(assistant.address)
		expect(assistant_image_balance_before.add(amount)).to.be.bignumber.eq(assistant_image_balance_after)

		expect((await assistant.balance_in_work())[0]).to.be.bignumber.eq(this.stake_balance_in_work)
		expect((await assistant.balance_in_work())[1]).to.be.bignumber.eq(this.image_balance_in_work)
		expect((await assistant.profit())[0]).to.be.bignumber.eq(this.stake_profit)
		expect((await assistant.profit())[1]).to.be.bignumber.eq(this.image_profit)
		expect((await assistant.mf())[0]).to.be.bignumber.eq(this.stake_mf)
		expect((await assistant.mf())[1]).to.be.bignumber.eq(this.image_mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	})

});
