// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./Governance.sol";
import "./GovernanceFactory.sol";
import "./VotedValueFactory.sol";
import "./VotedValueUint.sol";
import "./VotedValueUintArray.sol";
import "./CounterstakeLibrary.sol";


interface CounterstakeReceiver {
	function onReceivedFromClaim(uint claim_num, uint net_claimed_amount, uint won_stake, string memory sender_address, address claim_recipient_address, string memory data) external;
}

abstract contract Counterstake is ReentrancyGuard {

	using SafeERC20 for IERC20;

	event NewClaim(uint indexed claim_num, address author_address, string sender_address, address recipient_address, string txid, uint32 txts, uint amount, int reward, uint stake, string data, uint32 expiry_ts);
	event NewChallenge(uint indexed claim_num, address author_address, uint stake, CounterstakeLibrary.Side outcome, CounterstakeLibrary.Side current_outcome, uint yes_stake, uint no_stake, uint32 expiry_ts, uint challenging_target);
	event FinishedClaim(uint indexed claim_num, CounterstakeLibrary.Side outcome);

	Governance public governance;
	CounterstakeLibrary.Settings public settings;


	uint64 public last_claim_num;
	uint64[] public ongoing_claim_nums;
	mapping(uint => uint) public num2index;

	mapping(string => uint) public claim_nums;
	mapping(uint => CounterstakeLibrary.Claim) private claims;
	mapping(uint => mapping(CounterstakeLibrary.Side => mapping(address => uint))) public stakes;

	function getClaim(uint claim_num) external view returns (CounterstakeLibrary.Claim memory) {
		return claims[claim_num];
	}

	function getClaim(string memory claim_id) external view returns (CounterstakeLibrary.Claim memory) {
		return claims[claim_nums[claim_id]];
	}

	function getOngoingClaimNums() external view returns (uint64[] memory) {
		return ongoing_claim_nums;
	}


	constructor (address _tokenAddr, uint16 _counterstake_coef100, uint16 _ratio100, uint _large_threshold, uint[] memory _challenging_periods, uint[] memory _large_challenging_periods) {
		initCounterstake(_tokenAddr, _counterstake_coef100, _ratio100, _large_threshold, _challenging_periods, _large_challenging_periods);
	}

	function initCounterstake(address _tokenAddr, uint16 _counterstake_coef100, uint16 _ratio100, uint _large_threshold, uint[] memory _challenging_periods, uint[] memory _large_challenging_periods) public {
		require(address(governance) == address(0), "already initialized");
		validateRatio(_ratio100);
		validateCounterstakeCoef(_counterstake_coef100);
		validateChallengingPeriods(_challenging_periods);
		validateChallengingPeriods(_large_challenging_periods);
		settings = CounterstakeLibrary.Settings({
			tokenAddress: _tokenAddr,
			counterstake_coef100: _counterstake_coef100 > 100 ? _counterstake_coef100 : 150,
			ratio100: _ratio100 > 0 ? _ratio100 : 100,
			min_stake: 0,
			min_tx_age: 0,
			challenging_periods: _challenging_periods,
			large_challenging_periods: _large_challenging_periods,
			large_threshold: _large_threshold
		});
	}

	/*
	modifier onlyETH(){
		require(settings.tokenAddress == address(0), "ETH only");
		_;
	}

	modifier onlyERC20(){
		require(settings.tokenAddress != address(0), "ERC20 only");
		_;
	}*/

	modifier onlyVotedValueContract(){
		require(governance.addressBelongsToGovernance(msg.sender), "not from voted value contract");
		_;
	}

	// would be happy to call this from the constructor but unfortunately `this` is not set at that time yet
	function setupGovernance(GovernanceFactory governanceFactory, VotedValueFactory votedValueFactory) virtual public {
		require(address(governance) == address(0), "already initialized");
		governance = governanceFactory.createGovernance(address(this), settings.tokenAddress);

		governance.addVotedValue("ratio100", votedValueFactory.createVotedValueUint(governance, settings.ratio100, this.validateRatio, this.setRatio));
		governance.addVotedValue("counterstake_coef100", votedValueFactory.createVotedValueUint(governance, settings.counterstake_coef100, this.validateCounterstakeCoef, this.setCounterstakeCoef));
		governance.addVotedValue("min_stake", votedValueFactory.createVotedValueUint(governance, settings.min_stake, this.validateMinStake, this.setMinStake));
		governance.addVotedValue("min_tx_age", votedValueFactory.createVotedValueUint(governance, settings.min_tx_age, this.validateMinTxAge, this.setMinTxAge));
		governance.addVotedValue("large_threshold", votedValueFactory.createVotedValueUint(governance, settings.large_threshold, this.validateLargeThreshold, this.setLargeThreshold));
		governance.addVotedValue("challenging_periods", votedValueFactory.createVotedValueUintArray(governance, settings.challenging_periods, this.validateChallengingPeriods, this.setChallengingPeriods));
		governance.addVotedValue("large_challenging_periods", votedValueFactory.createVotedValueUintArray(governance, settings.large_challenging_periods, this.validateChallengingPeriods, this.setLargeChallengingPeriods));
	}

	function validateRatio(uint _ratio100) pure public {
		require(_ratio100 > 0 && _ratio100 < 64000, "bad ratio");
	}

	function setRatio(uint _ratio100) onlyVotedValueContract external {
		settings.ratio100 = uint16(_ratio100);
	}

	
	function validateCounterstakeCoef(uint _counterstake_coef100) pure public {
		require(_counterstake_coef100 > 100 && _counterstake_coef100 < 64000, "bad counterstake coef");
	}

	function setCounterstakeCoef(uint _counterstake_coef100) onlyVotedValueContract external {
		settings.counterstake_coef100 = uint16(_counterstake_coef100);
	}

	
	function validateMinStake(uint _min_stake) pure external {
		// anything goes
	}

	function setMinStake(uint _min_stake) onlyVotedValueContract external {
		settings.min_stake = _min_stake;
	}


	function validateMinTxAge(uint _min_tx_age) pure external {
		require(_min_tx_age < 4 weeks, "min tx age too large");
	}

	function setMinTxAge(uint _min_tx_age) onlyVotedValueContract external {
		settings.min_tx_age = uint32(_min_tx_age);
	}


	function validateLargeThreshold(uint _large_threshold) pure external {
		// anything goes
	}

	function setLargeThreshold(uint _large_threshold) onlyVotedValueContract external {
		settings.large_threshold = _large_threshold;
	}


	function validateChallengingPeriods(uint[] memory periods) pure public {
		CounterstakeLibrary.validateChallengingPeriods(periods);
	}

	function setChallengingPeriods(uint[] memory _challenging_periods) onlyVotedValueContract external {
		settings.challenging_periods = _challenging_periods;
	}

	function setLargeChallengingPeriods(uint[] memory _large_challenging_periods) onlyVotedValueContract external {
		settings.large_challenging_periods = _large_challenging_periods;
	}


	function getChallengingPeriod(uint16 period_number, bool bLarge) external view returns (uint) {
		return CounterstakeLibrary.getChallengingPeriod(settings, period_number, bLarge);
	}

	function getRequiredStake(uint amount) public view virtual returns (uint);

	function getMissingStake(uint claim_num, CounterstakeLibrary.Side stake_on) external view returns (uint) {
		CounterstakeLibrary.Claim storage c = claims[claim_num];
		require(c.yes_stake > 0, "no such claim");
		uint current_stake = (stake_on == CounterstakeLibrary.Side.yes) ? c.yes_stake : c.no_stake;
		return (c.current_outcome == CounterstakeLibrary.Side.yes ? c.yes_stake : c.no_stake) * settings.counterstake_coef100/100 - current_stake;
	}



	function claim(string memory txid, uint32 txts, uint amount, int reward, uint stake, string memory sender_address, address payable recipient_address, string memory data) nonReentrant payable external {
		if (recipient_address == address(0))
			recipient_address = payable(msg.sender);
		bool bThirdPartyClaiming = (recipient_address != payable(msg.sender) && reward >= 0);
		uint paid_amount;
		if (bThirdPartyClaiming) {
			require(amount > uint(reward), "reward too large");
			paid_amount = amount - uint(reward);
		}
		receiveMoneyInClaim(stake, paid_amount);
		uint required_stake = getRequiredStake(amount);
		CounterstakeLibrary.ClaimRequest memory req = CounterstakeLibrary.ClaimRequest({
			txid: txid,
			txts: txts,
			amount: amount,
			reward: reward,
			stake: stake,
			required_stake: required_stake,
			recipient_address: recipient_address,
			sender_address: sender_address,
			data: data
		});
		last_claim_num++;
		ongoing_claim_nums.push(last_claim_num);
		num2index[last_claim_num] = ongoing_claim_nums.length - 1;

		CounterstakeLibrary.claim(settings, claim_nums, claims, stakes, last_claim_num, req);
		
		if (bThirdPartyClaiming){
			sendToClaimRecipient(recipient_address, paid_amount);
			notifyPaymentRecipient(recipient_address, paid_amount, 0, last_claim_num);
		}
	}
	

	function challenge(string calldata claim_id, CounterstakeLibrary.Side stake_on, uint stake) payable external {
		challenge(claim_nums[claim_id], stake_on, stake);
	}

	function challenge(uint claim_num, CounterstakeLibrary.Side stake_on, uint stake) nonReentrant payable public {
		receiveStakeAsset(stake);
		CounterstakeLibrary.Claim storage c = claims[claim_num];
		require(c.amount > 0, "no such claim");
		CounterstakeLibrary.challenge(settings, c, stakes, claim_num, stake_on, stake);
	}

	function withdraw(string memory claim_id) external {
		withdraw(claim_nums[claim_id], payable(0));
	}

	function withdraw(uint claim_num) external {
		withdraw(claim_num, payable(0));
	}

	function withdraw(string memory claim_id, address payable to_address) external {
		withdraw(claim_nums[claim_id], to_address);
	}

	function withdraw(uint claim_num, address payable to_address) nonReentrant public {
		if (to_address == address(0))
			to_address = payable(msg.sender);
		require(claim_num > 0, "no such claim num");
		CounterstakeLibrary.Claim storage c = claims[claim_num];
		require(c.amount > 0, "no such claim");

		(bool finished, bool is_winning_claimant, uint won_stake) = CounterstakeLibrary.finish(c, stakes, claim_num, to_address);
		
		if (finished){
			uint index = num2index[claim_num];
			uint last_index = ongoing_claim_nums.length - 1;
			if (index != last_index){ // move the last element in place of our removed element
				require(index < last_index, "BUG index after last");
				uint64 claim_num_of_last_element = ongoing_claim_nums[last_index];
				num2index[claim_num_of_last_element] = index;
				ongoing_claim_nums[index] = claim_num_of_last_element;
			}
			ongoing_claim_nums.pop();
			delete num2index[claim_num];
		}

		uint claimed_amount_to_be_paid = is_winning_claimant ? c.amount : 0;
		sendWithdrawals(to_address, claimed_amount_to_be_paid, won_stake);
		notifyPaymentRecipient(to_address, claimed_amount_to_be_paid, won_stake, claim_num);
	}

//	event ExternalCall(bool res, string errtype, uint initial_gas, uint gas, address payment_recipient_address);

	function notifyPaymentRecipient(address payable payment_recipient_address, uint net_claimed_amount, uint won_stake, uint claim_num) private {
		if (CounterstakeLibrary.isContract(payment_recipient_address)){
			CounterstakeLibrary.Claim storage c = claims[claim_num];
			/*
			uint initial_gas = gasleft();
			try CounterstakeReceiver(payment_recipient_address).onReceivedFromClaim(claim_num, net_claimed_amount, won_stake, c.sender_address, c.recipient_address, c.data) {
				emit ExternalCall(true, "", initial_gas, gasleft(), payment_recipient_address);
			}
			catch Error(string memory){
				emit ExternalCall(false, "error", initial_gas, gasleft(), payment_recipient_address);
			}
			catch Panic(uint){
				emit ExternalCall(false, "panic", initial_gas, gasleft(), payment_recipient_address);
			}
			catch{
			//	emit ExternalCall(false, "catchall", initial_gas, gasleft(), payment_recipient_address);
			}
			*/
			(bool res, ) = payment_recipient_address.call(abi.encodeWithSignature("onReceivedFromClaim(uint256,uint256,uint256,string,address,string)", claim_num, net_claimed_amount, won_stake, c.sender_address, c.recipient_address, c.data));
		//	emit ExternalCall(res, payment_recipient_address);
		//	require(res || claim_num > 0, "unres");
			if (!res){
				// ignore
			}
		}
	}

	function receiveStakeAsset(uint stake_asset_amount) internal {
		if (settings.tokenAddress == address(0))
			require(msg.value == stake_asset_amount, "wrong amount received");
		else {
			require(msg.value == 0, "don't send ETH");
			IERC20(settings.tokenAddress).safeTransferFrom(msg.sender, address(this), stake_asset_amount);
		}
	}

	function sendWithdrawals(address payable to_address, uint claimed_amount_to_be_paid, uint won_stake) internal virtual;
	
	function sendToClaimRecipient(address payable to_address, uint paid_amount) internal virtual;

	function receiveMoneyInClaim(uint stake, uint paid_amount) internal virtual;

}
