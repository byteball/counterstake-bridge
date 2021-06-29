// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./ERC20.sol";
import "./Import.sol";
import "./CounterstakeLibrary.sol";

contract ImportAssistant is ERC20, ReentrancyGuard, CounterstakeReceiver {

	struct UintBalance {
		uint stake;
		uint image;
	}

	struct IntBalance {
		int stake;
		int image;
	}

	address public bridgeAddress;
	address public tokenAddress;
	address public managerAddress;

	uint16 public management_fee10000;
	uint16 public success_fee10000;

	uint8 public exponent;
	
	uint16 public swap_fee10000;

	uint public ts;
	IntBalance public profit;
	UintBalance public mf;
	UintBalance public balance_in_work;

	mapping(uint => UintBalance) public balances_in_work;

	Governance public governance;


	event NewClaimFor(uint claim_num, address for_address, string txid, uint32 txts, uint amount, int reward, uint stake);
	event AssistantChallenge(uint claim_num, CounterstakeLibrary.Side outcome, uint stake);
    event NewManager(address previousManager, address newManager);


	modifier onlyETH(){
		require(tokenAddress == address(0), "ETH only");
		_;
	}

/*	modifier onlyERC20(){
		require(tokenAddress != address(0), "ERC20 only");
		_;
	}*/

	modifier onlyBridge(){
		require(msg.sender == bridgeAddress, "not from bridge");
		_;
	}

    modifier onlyManager() {
        require(msg.sender == managerAddress, "caller is not the manager");
        _;
    }


	constructor(address bridgeAddr, address managerAddr, uint16 _management_fee10000, uint16 _success_fee10000, uint16 _swap_fee10000, uint8 _exponent, string memory name, string memory symbol) ERC20(name, symbol) {
		initImportAssistant(bridgeAddr, managerAddr, _management_fee10000, _success_fee10000, _swap_fee10000, _exponent, name, symbol);
	}

	function initImportAssistant(address bridgeAddr, address managerAddr, uint16 _management_fee10000, uint16 _success_fee10000, uint16 _swap_fee10000, uint8 _exponent, string memory _name, string memory _symbol) public {
		require(address(governance) == address(0), "already initialized");
		name = _name;
		symbol = _symbol;
		bridgeAddress = bridgeAddr;
		management_fee10000 = _management_fee10000;
		success_fee10000 = _success_fee10000;
		swap_fee10000 = _swap_fee10000;
		require(_exponent == 1 || _exponent == 2 || _exponent == 4, "only exponents 1, 2 and 4 are supported");
		exponent = _exponent;
		ts = block.timestamp;
		(address tokenAddr, , , , , ) = Import(bridgeAddr).settings();
		tokenAddress = tokenAddr;
		if (tokenAddr != address(0))
			IERC20(tokenAddr).approve(bridgeAddr, type(uint).max);
		managerAddress = (managerAddr != address(0)) ? managerAddr : msg.sender;
	}


	function getGrossBalance() internal view returns (UintBalance memory bal) {
		uint stake_bal = (tokenAddress == address(0)) ? address(this).balance : IERC20(tokenAddress).balanceOf(address(this));
		uint image_bal = IERC20(bridgeAddress).balanceOf(address(this));
		bal.stake = stake_bal + balance_in_work.stake;
		bal.image = image_bal + balance_in_work.image;
	}

	function updateMFAndGetBalances(uint just_received_stake_amount, uint just_received_image_amount, bool update) internal returns (UintBalance memory gross_balance, IntBalance memory net_balance) {
		gross_balance = getGrossBalance();
		gross_balance.stake -= just_received_stake_amount;
		gross_balance.image -= just_received_image_amount;
		uint new_mf_stake = mf.stake + gross_balance.stake * management_fee10000 * (block.timestamp - ts)/(360*24*3600)/1e4;
		uint new_mf_image = mf.image + gross_balance.image * management_fee10000 * (block.timestamp - ts)/(360*24*3600)/1e4;
		net_balance.stake = int(gross_balance.stake) - int(new_mf_stake) - max(profit.stake * int16(success_fee10000)/1e4, 0);
		net_balance.image = int(gross_balance.image) - int(new_mf_image) - max(profit.image * int16(success_fee10000)/1e4, 0);
		// to save gas, we don't update mf when the balances don't change
		if (update) {
			mf.stake = new_mf_stake;
			mf.image = new_mf_image;
			ts = block.timestamp;
		}
	}

	

	function claim(string memory txid, uint32 txts, uint amount, int reward, string memory sender_address, address payable recipient_address, string memory data) onlyManager nonReentrant external {
		require(reward >= 0, "negative reward");
		uint claim_num = Import(bridgeAddress).last_claim_num() + 1;
		uint required_stake = Import(bridgeAddress).getRequiredStake(amount);
		uint paid_amount = amount - uint(reward);
		require(required_stake < uint(type(int).max), "required_stake too large");
		require(paid_amount < uint(type(int).max), "paid_amount too large");
		{ // stack too deep
			(, IntBalance memory net_balance) = updateMFAndGetBalances(0, 0, false);
			require(net_balance.stake > 0, "no net balance in stake asset");
			require(net_balance.image > 0, "no net balance in image asset");
			require(required_stake <= uint(net_balance.stake), "not enough balance in stake asset");
			require(paid_amount <= uint(net_balance.image), "not enough balance in image asset");
			balances_in_work[claim_num] = UintBalance({stake: required_stake, image: paid_amount});
			balance_in_work.stake += required_stake;
			balance_in_work.image += paid_amount;
		}

		emit NewClaimFor(claim_num, recipient_address, txid, txts, amount, reward, required_stake);

		Import(bridgeAddress).claim{value: tokenAddress == address(0) ? required_stake : 0}(txid, txts, amount, reward, required_stake, sender_address, recipient_address, data);
	}

	function challenge(uint claim_num, CounterstakeLibrary.Side stake_on, uint stake) onlyManager nonReentrant external {
		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, 0, false);
		require(net_balance.stake > 0, "no net balance");

		uint missing_stake = Import(bridgeAddress).getMissingStake(claim_num, stake_on);
		if (stake == 0 || stake > missing_stake) // send the stake without excess as we can't account for it
			stake = missing_stake;

		require(stake <= uint(net_balance.stake), "not enough balance");
		Import(bridgeAddress).challenge{value: tokenAddress == address(0) ? stake : 0}(claim_num, stake_on, stake);
		balances_in_work[claim_num].stake += stake;
		balance_in_work.stake += stake;
		emit AssistantChallenge(claim_num, stake_on, stake);
	}

	receive() external payable onlyETH {
		// silently receive Ether from claims
	}

	function onReceivedFromClaim(uint claim_num, uint claimed_amount, uint won_stake, string memory, address, string memory) onlyBridge override external {
		updateMFAndGetBalances(won_stake, claimed_amount, true); // this is already added to our balance

		UintBalance storage invested = balances_in_work[claim_num];
		require(invested.stake > 0, "BUG: I didn't stake in this claim?");

		if (won_stake >= invested.stake){
			uint this_profit = won_stake - invested.stake;
			require(this_profit < uint(type(int).max), "stake profit too large");
			profit.stake += int(this_profit);
		}
		else { // avoid negative values
			uint loss = invested.stake - won_stake;
			require(loss < uint(type(int).max), "stake loss too large");
			profit.stake -= int(loss);
		}

		if (claimed_amount >= invested.image){
			uint this_profit = claimed_amount - invested.image;
			require(this_profit < uint(type(int).max), "image profit too large");
			profit.image += int(this_profit);
		}
		else { // avoid negative values
			uint loss = invested.image - claimed_amount;
			require(loss < uint(type(int).max), "image loss too large");
			profit.image -= int(loss);
		}

		balance_in_work.stake -= invested.stake;
		balance_in_work.image -= invested.image;
		delete balances_in_work[claim_num];
	}

	// Record a loss, called by anybody.
	// Should be called only if I staked on the losing side only.
	// If I staked on the winning side too, the above function should be called.
	function recordLoss(uint claim_num) nonReentrant external {
		updateMFAndGetBalances(0, 0, true);

		UintBalance storage invested = balances_in_work[claim_num];
		require(invested.stake > 0, "this claim is already accounted for");
		
		CounterstakeLibrary.Claim memory c = Import(bridgeAddress).getClaim(claim_num);
		require(c.amount > 0, "no such claim");
		require(block.timestamp > c.expiry_ts, "not expired yet");
		CounterstakeLibrary.Side opposite_outcome = c.current_outcome == CounterstakeLibrary.Side.yes ? CounterstakeLibrary.Side.no : CounterstakeLibrary.Side.yes;
		
		uint my_winning_stake = Import(bridgeAddress).stakes(claim_num, c.current_outcome, address(this));
		require(my_winning_stake == 0, "have a winning stake in this claim");
		
		uint my_losing_stake = Import(bridgeAddress).stakes(claim_num, opposite_outcome, address(this));
		require(my_losing_stake > 0, "no losing stake in this claim");
		require(invested.stake == my_losing_stake, "BUG: losing stake mismatch");

		require(invested.stake < uint(type(int).max), "stake loss too large");
		require(invested.image < uint(type(int).max), "image loss too large");
		profit.stake -= int(invested.stake);
		profit.image -= int(invested.image);

		balance_in_work.stake -= invested.stake;
		balance_in_work.image -= invested.image;
		delete balances_in_work[claim_num];
	}


	// share issue/redeem functions

	function buyShares(uint stake_asset_amount, uint image_asset_amount) payable nonReentrant external {
		if (tokenAddress == address(0))
			require(msg.value == stake_asset_amount, "wrong amount received");
		else {
			require(msg.value == 0, "don't send ETH");
			require(IERC20(tokenAddress).transferFrom(msg.sender, address(this), stake_asset_amount), "failed to pull stake");
		}
		require(IERC20(bridgeAddress).transferFrom(msg.sender, address(this), image_asset_amount), "failed to pull image");

		(UintBalance memory gross_balance, IntBalance memory net_balance) = updateMFAndGetBalances(stake_asset_amount, image_asset_amount, true);
		require((gross_balance.stake == 0) == (totalSupply() == 0), "bad init state");
		uint shares_amount;
		if (totalSupply() == 0){ // initial issue
			require(stake_asset_amount > 0 && image_asset_amount > 0, "must supply both assets for initial issue");
			shares_amount = getShares(stake_asset_amount, image_asset_amount) / 10**(18 - decimals());
		}
		else {
			require(net_balance.stake > 0, "no stake net balance");
			require(net_balance.image > 0, "no image net balance");
			uint new_shares_supply = totalSupply() * getShares(uint(net_balance.stake) + stake_asset_amount, uint(net_balance.image) + image_asset_amount) / getShares(uint(net_balance.stake), uint(net_balance.image));
			shares_amount = new_shares_supply - totalSupply();
		}
		_mint(msg.sender, shares_amount);

		// this should overflow now, not when we try to redeem. We won't see the error message, will revert while trying to evaluate the expression
		require(Math.max(gross_balance.stake + stake_asset_amount, gross_balance.image + image_asset_amount) * totalSupply()**exponent > 0, "too many shares, would overflow");
	}

	function redeemShares(uint shares_amount) nonReentrant external {
		uint old_shares_supply = totalSupply();

		_burn(msg.sender, shares_amount);
		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, 0, true);
		require(net_balance.stake > 0, "negative net balance in stake asset");
		require(net_balance.image > 0, "negative net balance in image asset");
		require(uint(net_balance.stake) > balance_in_work.stake, "negative risk-free net balance in stake asset");
		require(uint(net_balance.image) > balance_in_work.image, "negative risk-free net balance in image asset");
		
		uint stake_asset_amount = (uint(net_balance.stake) - balance_in_work.stake) * (old_shares_supply**exponent - (old_shares_supply - shares_amount)**exponent) / old_shares_supply**exponent;
		stake_asset_amount -= stake_asset_amount * swap_fee10000/10000;

		uint image_asset_amount = (uint(net_balance.image) - balance_in_work.image) * (old_shares_supply**exponent - (old_shares_supply - shares_amount)**exponent) / old_shares_supply**exponent;
		image_asset_amount -= image_asset_amount * swap_fee10000/10000;
		
		payStakeTokens(msg.sender, stake_asset_amount);
		payImageTokens(msg.sender, image_asset_amount);
	}


	// swapping finctions

	function swapImage2Stake(uint image_asset_amount) nonReentrant external {
		require(IERC20(bridgeAddress).transferFrom(msg.sender, address(this), image_asset_amount), "failed to pull image");

		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, image_asset_amount, false);
		require(net_balance.stake > 0, "negative net balance in stake asset");
		require(net_balance.image > 0, "negative net balance in image asset");
		require(uint(net_balance.stake) > balance_in_work.stake, "negative risk-free net balance in stake asset");

		uint stake_asset_amount = (uint(net_balance.stake) - balance_in_work.stake) * image_asset_amount / (uint(net_balance.image) + image_asset_amount);
		stake_asset_amount -= stake_asset_amount * swap_fee10000/10000;

		payStakeTokens(msg.sender, stake_asset_amount);
	}

	function swapStake2Image(uint stake_asset_amount) payable nonReentrant external {
		if (tokenAddress == address(0))
			require(msg.value == stake_asset_amount, "wrong amount received");
		else {
			require(msg.value == 0, "don't send ETH");
			require(IERC20(tokenAddress).transferFrom(msg.sender, address(this), stake_asset_amount), "failed to pull stake");
		}

		(, IntBalance memory net_balance) = updateMFAndGetBalances(stake_asset_amount, 0, false);
		require(net_balance.stake > 0, "negative net balance in stake asset");
		require(net_balance.image > 0, "negative net balance in image asset");
		require(uint(net_balance.image) > balance_in_work.image, "negative risk-free net balance in image asset");

		uint image_asset_amount = (uint(net_balance.image) - balance_in_work.image) * stake_asset_amount / (uint(net_balance.stake) + stake_asset_amount);
		image_asset_amount -= image_asset_amount * swap_fee10000/10000;

		payImageTokens(msg.sender, image_asset_amount);
	}


	// manager functions

	function withdrawManagementFee() onlyManager nonReentrant external {
		updateMFAndGetBalances(0, 0, true);
		payStakeTokens(msg.sender, mf.stake);
		payImageTokens(msg.sender, mf.image);
		mf.stake = 0;
		mf.image = 0;
	}

	function withdrawSuccessFee() onlyManager nonReentrant external {
		updateMFAndGetBalances(0, 0, true);
		if (profit.stake > 0) {
			uint sf = uint(profit.stake) * success_fee10000/1e4;
			payStakeTokens(msg.sender, sf);
			profit.stake = 0;
		}
		if (profit.image > 0) {
			uint sf = uint(profit.image) * success_fee10000/1e4;
			payImageTokens(msg.sender, sf);
			profit.image = 0;
		}
	}

	// zero address is allowed
    function assignNewManager(address newManager) onlyManager external {
		emit NewManager(managerAddress, newManager);
        managerAddress = newManager;
    }


	// governance functions

	modifier onlyVotedValueContract(){
		require(governance.addressBelongsToGovernance(msg.sender), "not from voted value contract");
		_;
	}

	// would be happy to call this from the constructor but unfortunately `this` is not set at that time yet
	function setupGovernance(GovernanceFactory governanceFactory, VotedValueFactory votedValueFactory) external {
		require(address(governance) == address(0), "already initialized");
		governance = governanceFactory.createGovernance(address(this), address(this));

		governance.addVotedValue("swap_fee10000", votedValueFactory.createVotedValueUint(governance, swap_fee10000, this.validateSwapFee, this.setSwapFee));
	}



	function validateSwapFee(uint _swap_fee10000) pure external {
		require(_swap_fee10000 < 10000, "bad swap fee");
	}

	function setSwapFee(uint _swap_fee10000) onlyVotedValueContract external {
		swap_fee10000 = uint16(_swap_fee10000);
	}


	// helper functions

	function payStakeTokens(address to, uint amount) internal {
		if (tokenAddress == address(0))
			payable(to).transfer(amount);
		else
			require(IERC20(tokenAddress).transfer(to, amount), "failed to transfer stake asset");
	}

	function payImageTokens(address to, uint amount) internal {
		require(IERC20(bridgeAddress).transfer(to, amount), "failed to transfer image asset");
	}

	function getShares(uint stake_balance, uint image_balance) view internal returns (uint) {
		uint gm = sqrt(stake_balance * image_balance);
		if (exponent == 1)
			return gm;
		if (exponent == 2)
			return sqrt(gm);
		if (exponent == 4)
			return sqrt(sqrt(gm));
		revert("bad exponent");
	}

	// for large exponents, we need more room to **exponent without overflow
	function decimals() public view override returns (uint8) {
		return exponent > 2 ? 9 : 18;
	}


	function max(int a, int b) internal pure returns (int) {
		return a > b ? a : b;
	}

	// babylonian method (https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method)
	function sqrt(uint y) internal pure returns (uint z) {
		if (y > 3) {
			z = y;
			uint x = y / 2 + 1;
			while (x < z) {
				z = x;
				x = (y / x + x) / 2;
			}
		} else if (y != 0) {
			z = 1;
		}
	}

}

