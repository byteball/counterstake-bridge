require('@openzeppelin/test-helpers/configure')({
	provider: 'http://localhost:7545',
});

const Export = artifacts.require("Export");
const Governance = artifacts.require("Governance");
const VotedValueUint = artifacts.require("VotedValueUint");
const VotedValueUintArray = artifacts.require("VotedValueUintArray");
const CounterstakeFactory = artifacts.require("CounterstakeFactory");
const AssistantFactory = artifacts.require("AssistantFactory");
const ExportAssistant = artifacts.require("ExportAssistant");
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

contract("Exporting ETH with the help of pooled assistant contract", async accounts => {
	const aliceAccount = accounts[0]
	const bobAccount = accounts[1]
	const charlieAccount = accounts[2]
	const managerAccount = accounts[3]

	let instance, governance, ratioVotedValue, counterstakeCoefVotedValue, largeThresholdVotedValue, challengingPeriodsVotedValue, largeChallengingPeriodsVotedValue, assistant;
	
	before(async () => {
		const factory = await CounterstakeFactory.deployed();
		console.log('Factory address', factory.address);

	//	instance = await Export.deployed();

		let res = await factory.createExport("Obyte", "OTKN", constants.ZERO_ADDRESS, 150, 100, ether('100'), [12 * 3600, 3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600], [3 * 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]);
		console.log('create result', res)
		instance = await Export.at(res.logs[0].args.contractAddress);
		console.log('ETH export address', instance.address);

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
		expect(await governance.votingTokenAddress()).to.be.equal(constants.ZERO_ADDRESS);
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

		let assistant_res = await assistantFactory.createExportAssistant(instance.address, managerAccount, 100, 2500, 1, "ETH-to-Obyte export assistant", "ETHOA");
		assistant = await ExportAssistant.at(assistant_res.logs[0].args.contractAddress);
		console.log('ETH-to-Obyte export assistant address', assistant.address);

		expect(await assistant.profit_diffusion_period()).to.be.bignumber.eq(new BN(10 * 24 * 3600));
	});

	it("start expatriation", async () => {
		const amount = ether('7')
		const reward = bn0
		const foreign_address = "ADDR"
		const data = ""
		let res = await instance.transferToForeignChain(foreign_address, data, amount, reward, { value: amount, from: aliceAccount });
		expectEvent(res, 'NewExpatriation', { sender_address: aliceAccount, amount, reward, foreign_address, data });
		let bal = await web3.eth.getBalance(instance.address);
		expect(bal).to.be.bignumber.equal(amount);
	});

	it("bob buys shares in the assistant", async () => {
		const amount = ether('20')
		let res = await assistant.buyShares(amount, { value: amount, from: bobAccount });
		expectEvent(res, 'Transfer', { from: a0, to: bobAccount, value: amount });
		this.mf = bn0;
		this.ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		
		let assistant_bal = await web3.eth.getBalance(assistant.address);
		expect(assistant_bal).to.be.bignumber.equal(amount);

		// bobs shares balance
		let bob_bal = await assistant.balanceOf(bobAccount);
		expect(bob_bal).to.be.bignumber.equal(amount);
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
		let balance_before = await balance.current(aliceAccount);
	//	console.log('balance before claim', balance_before.toString())

		const txid = 'transid';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.profit = amount.sub(paid_amount)
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		console.log('assistant claim res', res)
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
		this.claim_num = new BN(1)
		this.txts = txts
		this.claim = expected_claim;
	//	expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: assistant.address, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
	//	console.log('claim', claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(stake);

	//	this.mf = ether('20').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.ts = ts
		this.balance_in_work = paid_amount.add(stake)
		expect(await assistant.balance_in_work()).to.be.bignumber.eq(paid_amount.add(stake))
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(paid_amount.add(stake))
		expect(await assistant.profit()).to.be.bignumber.eq(bn0)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await balance.current(aliceAccount);
	//	console.log('balance after claim', balance_after.toString())
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("failed claim: same txid again", async () => {
		const txid = 'transid';
		const amount = ether('4')
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
		const stake = ether('1');
		const outcome = no;
		const res = await instance.challengeById(this.claim_id, outcome, stake, { value: stake, from: charlieAccount });
		expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: charlieAccount, stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: stake, challenging_target: this.challenging_target });
		this.claim.no_stake = stake;
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(stake);
		this.profit = this.profit.add(stake); // charlie will lose and his stake will become our profit
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

	it("failed record win 1: not finished yet", async () => {
		let promise = assistant.recordWin(this.claim_num, { from: bobAccount });
		await expectRevert(promise, "not finished yet");
	});
	
	it("withdraw", async () => {
		let balance_before = await balance.current(assistant.address);
	//	console.log('balance before withdrawal', balance_before.toString())

	//	let gas = 150000;//await instance.withdrawTo.estimateGas(this.claim_id, assistant.address, { from: bobAccount });
	//	console.log('gas estimation for withdrawal', gas);
		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		console.log('withdraw to assistant res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await balance.current(assistant.address);
	//	console.log('balance after withdrawal', balance_after.toString())
		expect(balance_before.add(ether('9'))).to.be.bignumber.equal(balance_after); // 4+4+1

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(bn0);
		expect(await instance.stakes(this.claim_num, no, charlieAccount)).to.be.bignumber.equal(ether('1'));

		const delta_mf = ether('20').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts
		this.recent_profit = this.profit
		this.recent_profit_ts = ts
		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		expect(await assistant.recent_profit()).to.be.bignumber.eq(this.recent_profit)
		expect(await assistant.recent_profit_ts()).to.be.bignumber.eq(new BN(this.recent_profit_ts))

		// if the callback fails:
		/*
		expect(await assistant.balance_in_work()).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.profit()).to.be.bignumber.eq(bn0)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		*/
	});

	/*
	// if the callback fails:
	it("record win after withdrawal", async () => {
		let res = await assistant.recordWin(this.claim_num, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = ether('20').mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts
		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	//	expect(0).to.eq(1)
	});
	*/

	it("failed record win 1: this claim is already accounted for", async () => {
		let promise = assistant.recordWin(this.claim_num, { from: bobAccount });
		await expectRevert(promise, "this claim is already accounted for");
	});

	it("failed withdraw: already withdrawn", async () => {
		let promise = instance.withdrawTo(this.claim_id, assistant.address, { from: managerAccount });
		await expectRevert(promise, "already withdrawn");
	});





	it("alice claims some coins she didn't receive", async () => {
		const txid = 'transid2';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('4')
		const stake = ether('4')
		const sender_address = "SENDER"
		const data = ""
		const reward = bn0
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
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
		this.claim_num = new BN(2)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);

		expect(await assistant.recent_profit()).to.be.bignumber.eq(this.recent_profit)
		expect(await assistant.recent_profit_ts()).to.be.bignumber.eq(new BN(this.recent_profit_ts))
	});

	it("challenge by assistant, outcome changed", async () => {
		await time.increase(3600);
		let balance_before = await balance.current(assistant.address);

		const stake = ether('6.5'); // need 6 total, 0.5 excess
		const accepted_stake = ether('6')
		const outcome = no;
		const res = await assistant.challenge(this.claim_num, outcome, stake, { from: managerAccount });
		console.log('assistant challenge res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;
		this.claim.expiry_ts = new BN(ts + 3 * 24 * 3600);
		this.claim.period_number = bn1;
		this.claim.current_outcome = no;
		this.claim.no_stake = this.claim.no_stake.add(accepted_stake); // 6 accepted, 0.5 excess
		this.challenging_target = this.challenging_target.mul(new BN(150)).div(new BN(100));
	//	expectEvent(res, 'NewChallenge', { claim_num: this.claim_num, author_address: assistant.address, stake: accepted_stake, outcome, current_outcome: this.claim.current_outcome, expiry_ts: this.claim.expiry_ts, yes_stake: this.claim.yes_stake, no_stake: this.claim.no_stake, challenging_target: this.challenging_target });
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(accepted_stake);

		// check the balance
		let balance_after = await balance.current(assistant.address);
		expect(balance_before.sub(accepted_stake)).to.be.bignumber.equal(balance_after);

		const delta_mf = balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.mf = this.mf.add(delta_mf)
	//	this.ts = ts

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(accepted_stake)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(accepted_stake)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		expect(await assistant.recent_profit()).to.be.bignumber.eq(this.recent_profit)
		expect(await assistant.recent_profit_ts()).to.be.bignumber.eq(new BN(this.recent_profit_ts))
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

	it("failed record win 2: not finished yet", async () => {
		let promise = assistant.recordWin(this.claim_num, { from: bobAccount });
		await expectRevert(promise, "not finished yet");
	});
	
	it("withdraw to assistant", async () => {
		let balance_before = await balance.current(assistant.address);

		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		console.log('withdraw to assistant res', res)
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await balance.current(assistant.address);
		expect(balance_before.add(ether('4')).add(ether('6'))).to.be.bignumber.equal(balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(ether('4'));
		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(bn0);

		const delta_mf = balance_before.add(ether('6')).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts
		this.profit = this.profit.add(ether('4'));

		const elapsed = ts - this.recent_profit_ts
		expect(elapsed).to.be.closeTo(3600 + 3 * 24 * 3600 + 1, 10)
		this.recent_profit = this.recent_profit.mul(new BN(10 * 24 * 3600 - elapsed)).div(new BN(10 * 24 * 3600)).add(ether('4'))
		this.recent_profit_ts = ts

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		expect(await assistant.recent_profit()).to.be.bignumber.eq(this.recent_profit)
		expect(await assistant.recent_profit_ts()).to.be.bignumber.eq(new BN(this.recent_profit_ts))
	});

	it("failed record win 2: this claim is already accounted for", async () => {
		let promise = assistant.recordWin(this.claim_num, { from: bobAccount });
		await expectRevert(promise, "this claim is already accounted for");
	});
	
	it("alice trigers a loss and fails because there is no loss to the assistant", async () => {
		let promise = assistant.recordLoss(this.claim_num, { from: aliceAccount });
		await expectRevert(promise, "this claim is already accounted for");
	});

	it("bob redeems some shares", async () => {
		let assistant_balance_before = await balance.current(assistant.address);
		let bob_balance_before = await balance.current(bobAccount);

		const shares_amount = ether('5')

		const res = await assistant.redeemShares(shares_amount, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));

		let assistant_balance_after = await balance.current(assistant.address);
		let bob_balance_after = await balance.current(bobAccount);

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		const sf = this.profit.mul(new BN(25)).div(new BN(100))
		const net_balance = assistant_balance_before.sub(this.mf).sub(sf)
		const elapsed = ts - this.recent_profit_ts
		const unavailable_profit = this.recent_profit.mul(new BN(10 * 24 * 3600 - elapsed)).div(new BN(10 * 24 * 3600))
		const payout = net_balance.sub(unavailable_profit).mul(shares_amount).div(ether('20'))
		expect(assistant_balance_before.sub(payout)).to.be.bignumber.eq(assistant_balance_after)
		expect(bob_balance_before.sub(gasCost).add(payout)).to.be.bignumber.eq(bob_balance_after)

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	

	it("alice buys some shares", async () => {
		let assistant_balance_before = await balance.current(assistant.address);

		const amount = ether('5')

		const res = await assistant.buyShares(amount, { value: amount, from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		const sf = this.profit.mul(new BN(25)).div(new BN(100))
		const net_balance = assistant_balance_before.sub(this.mf).sub(sf)
		const shares_amount = ether('15').mul(amount).div(net_balance)
		expect(await assistant.balanceOf(aliceAccount)).to.be.bignumber.eq(shares_amount)

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	

	it("manager withdraws his management fee", async () => {
		let assistant_balance_before = await balance.current(assistant.address);
		let manager_balance_before = await balance.current(managerAccount);

		const res = await assistant.withdrawManagementFee({ from: managerAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let assistant_balance_after = await balance.current(assistant.address);
		let manager_balance_after = await balance.current(managerAccount);
		expect(assistant_balance_before.sub(this.mf)).to.be.bignumber.eq(assistant_balance_after)
		expect(manager_balance_before.sub(gasCost).add(this.mf)).to.be.bignumber.eq(manager_balance_after)
		this.mf = bn0

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});

	it("manager withdraws his success fee", async () => {
		let assistant_balance_before = await balance.current(assistant.address);
		let manager_balance_before = await balance.current(managerAccount);

		const res = await assistant.withdrawSuccessFee({ from: managerAccount, gas: 1e6 });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		const sf = this.profit.mul(new BN(25)).div(new BN(100))

		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let assistant_balance_after = await balance.current(assistant.address);
		let manager_balance_after = await balance.current(managerAccount);
		expect(assistant_balance_before.sub(sf)).to.be.bignumber.eq(assistant_balance_after)
		expect(manager_balance_before.sub(gasCost).add(sf)).to.be.bignumber.eq(manager_balance_after)
		this.profit = bn0

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

	});
	



	it("claim 3", async () => {
		let assistant_balance_before = await balance.current(assistant.address);
		let balance_before = await balance.current(aliceAccount);
	//	console.log('balance before claim', balance_before.toString())

		const txid = 'transid3';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('2')
		const stake = ether('2')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.paid_amount = paid_amount
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		console.log('assistant claim 3 res', res)
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
		this.claim_num = new BN(3)
		this.txts = txts
		this.claim = expected_claim;
	//	expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: assistant.address, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(stake);

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.mf = this.mf.add(delta_mf)
	//	this.ts = ts

		this.balance_in_work = paid_amount.add(stake)

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.profit()).to.be.bignumber.eq(bn0)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await balance.current(aliceAccount);
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("Manager challenges his own claim and overturns the outcome", async () => {
		await time.increase(3600);
		let balance_before = await balance.current(assistant.address);

		const stake = bn0;
		const accepted_stake = ether('3')
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
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('2'));

		// check the balance
		let balance_after = await balance.current(assistant.address);
		expect(balance_before.sub(accepted_stake)).to.be.bignumber.equal(balance_after);

		const delta_mf = balance_before.add(this.balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.mf = this.mf.add(delta_mf)
	//	this.ts = ts

		this.balance_in_work = this.balance_in_work.add(accepted_stake)

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.profit()).to.be.bignumber.eq(bn0)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});

	it("withdraw to assistant", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let balance_before = await balance.current(assistant.address);

		let res = await instance.withdrawTo(this.claim_id, assistant.address, { from: bobAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		let balance_after = await balance.current(assistant.address);
		expect(balance_before.add(ether('2')).add(ether('3'))).to.be.bignumber.equal(balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('2'));
		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(bn0);

		const delta_mf = balance_before.add(this.balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts
		this.profit = bn0.sub(this.paid_amount);

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});



	it("claim 4", async () => {
		let assistant_balance_before = await balance.current(assistant.address);
		let balance_before = await balance.current(aliceAccount);
	//	console.log('balance before claim', balance_before.toString())

		const txid = 'transid4';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('1')
		const stake = ether('1')
		const sender_address = "SENDER"
		const data = ""
		const reward = amount.div(new BN(100))
		const paid_amount = amount.sub(reward)
		this.paid_amount = paid_amount
		let res = await assistant.claim(txid, txts, amount, reward, sender_address, aliceAccount, data, { from: managerAccount });
		console.log('assistant claim 4 res', res)
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

		const delta_mf = assistant_balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.mf = this.mf.add(delta_mf)
	//	this.ts = ts

		this.balance_in_work = paid_amount.add(stake)

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(this.balance_in_work)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))

		// alice received her 99% of the claimed amount
		let balance_after = await balance.current(aliceAccount);
		expect(balance_before.add(paid_amount)).to.be.bignumber.equal(balance_after);
	});

	it("bob challenges the claim and overturns the outcome", async () => {
		await time.increase(3600);

		const stake = ether('1.5');
		const outcome = no;
		const res = await instance.challengeById(this.claim_id, outcome, stake, { value: stake, from: bobAccount });
		console.log('bob challenge res', res)
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
		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('1'));

	});

	it("withdraw to bob", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let balance_before = await balance.current(bobAccount);

		let res = await instance.withdrawById(this.claim_id, { from: bobAccount });
		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(bobAccount);
		expect(balance_before.sub(gasCost).add(ether('2.5'))).to.be.bignumber.equal(balance_after);

	//	this.claim.withdrawn = false; // stays false
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, yes, assistant.address)).to.be.bignumber.equal(ether('1'));
		expect(await instance.stakes(this.claim_num, no, bobAccount)).to.be.bignumber.equal(bn0);

	});

	it("record the loss", async () => {
		let assistant_balance_before = await balance.current(assistant.address);

		let res = await assistant.recordLoss(this.claim_num, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = assistant_balance_before.add(this.balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		this.profit = this.profit.sub(this.balance_in_work)
		this.balance_in_work = bn0

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		
	});



	it("claim 5: alice claims some coins", async () => {
		const txid = 'transid5';
		const txts = Math.floor(Date.now()/1000)
		const amount = ether('0.5')
		const stake = ether('0.5')
		const sender_address = "SENDER"
		const data = ""
		const reward = new BN(-1)
		let res = await instance.claim(txid, txts, amount, reward, stake, sender_address, a0, data, { value: stake, from: aliceAccount });
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
		this.claim_num = new BN(5)
		this.claim = expected_claim;
		expectEvent(res, 'NewClaim', { claim_num: this.claim_num, txid, txts: new BN(txts), author_address: aliceAccount, sender_address, recipient_address: aliceAccount, amount, reward, stake, data, expiry_ts: new BN(expiry_ts) });
		let claim = await instance.getClaimById(claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(expected_claim));

		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(stake);

	});

	it("challenge by assistant, outcome unchanged", async () => {
		await time.increase(3600);
		let balance_before = await balance.current(assistant.address);

		const stake = ether('0.1');
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
		let balance_after = await balance.current(assistant.address);
		expect(balance_before.sub(stake)).to.be.bignumber.equal(balance_after);

		const delta_mf = balance_before.mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
	//	this.mf = this.mf.add(delta_mf)
	//	this.ts = ts

		this.balance_in_work = stake

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(stake)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(stake)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
	});


	it("withdraw to alice", async () => {
		await time.increase(3 * 24 * 3600 + 1);
		let balance_before = await balance.current(aliceAccount);

		let res = await instance.withdrawById(this.claim_id, { from: aliceAccount });
		expectEvent(res, 'FinishedClaim', { claim_num: this.claim_num, outcome: this.claim.current_outcome });

		// check the balance
		const tx = await web3.eth.getTransaction(res.tx);
		const gasPrice = new BN(tx.gasPrice);
		const gasCost = gasPrice.mul(new BN(res.receipt.cumulativeGasUsed));
		let balance_after = await balance.current(aliceAccount);
		expect(balance_before.sub(gasCost).add(ether('1.1'))).to.be.bignumber.equal(balance_after);

		this.claim.withdrawn = true;
		this.claim.finished = true
		let claim = await instance.getClaimById(this.claim_id);
		claim = removeNumericKeys(claim);
		expect(bn2string(claim)).to.deep.equal(bn2string(this.claim));

		expect(await instance.stakes(this.claim_num, no, assistant.address)).to.be.bignumber.equal(ether('0.1'));
		expect(await instance.stakes(this.claim_num, yes, aliceAccount)).to.be.bignumber.equal(bn0);

	});


	it("record the loss", async () => {
		let assistant_balance_before = await balance.current(assistant.address);

		let res = await assistant.recordLoss(this.claim_num, { from: aliceAccount });
		const ts = (await web3.eth.getBlock(res.receipt.blockNumber)).timestamp;

		const delta_mf = assistant_balance_before.add(this.balance_in_work).mul(new BN(ts - this.ts)).div(year).mul(new BN(1)).div(new BN(100))
		this.mf = this.mf.add(delta_mf)
		this.ts = ts

		this.profit = this.profit.sub(this.balance_in_work)
		this.balance_in_work = bn0

		expect(await assistant.balance_in_work()).to.be.bignumber.eq(bn0)
		expect(await assistant.balances_in_work(this.claim_num)).to.be.bignumber.eq(bn0)
		expect(await assistant.profit()).to.be.bignumber.eq(this.profit)
		expect(await assistant.mf()).to.be.bignumber.eq(this.mf)
		expect(await assistant.ts()).to.be.bignumber.eq(new BN(this.ts))
		
	});

});
