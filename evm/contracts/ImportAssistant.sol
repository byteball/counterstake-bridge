// SPDX-License-Identifier: MIT
pragma solidity ^0.8.3;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "./ERC20.sol";
import "./Import.sol";
import "./CounterstakeLibrary.sol";

contract ImportAssistant is ERC20, ReentrancyGuard, CounterstakeReceiver, ERC165 {

	using SafeERC20 for IERC20;

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

	uint16 public swap_fee10000;
	uint16 public exit_fee10000; // 0 by default

	uint8 public exponent;
	
	uint constant default_profit_diffusion_period = 10 days;
	uint public profit_diffusion_period = default_profit_diffusion_period;

	uint public ts;
	IntBalance public profit;
	UintBalance public mf;
	UintBalance public balance_in_work;

	mapping(uint => UintBalance) public balances_in_work;

	UintBalance public recent_profit;
	uint public recent_profit_ts;

	uint public network_fee_compensation;

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
			IERC20(tokenAddr).safeApprove(bridgeAddr, type(uint).max);
		managerAddress = (managerAddr != address(0)) ? managerAddr : msg.sender;
		profit_diffusion_period = default_profit_diffusion_period;
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
		net_balance.stake = int(gross_balance.stake) - int(new_mf_stake) - max(profit.stake * int16(success_fee10000)/1e4, 0) - int(network_fee_compensation);
		net_balance.image = int(gross_balance.image) - int(new_mf_image) - max(profit.image * int16(success_fee10000)/1e4, 0);
		// to save gas, we don't update mf when the balances don't change
		if (update) {
			mf.stake = new_mf_stake;
			mf.image = new_mf_image;
			ts = block.timestamp;
		}
	}

	// part of the profit that has not diffused into the balance available for withdraw yet
	function getUnavailableProfit() public view returns (UintBalance memory) {
		uint elapsed = block.timestamp - recent_profit_ts;
		return (elapsed >= profit_diffusion_period) 
			? UintBalance(0, 0)
			: UintBalance({
				stake: recent_profit.stake * (profit_diffusion_period - elapsed) / profit_diffusion_period,
				image: recent_profit.image * (profit_diffusion_period - elapsed) / profit_diffusion_period
			});
	}

	function addRecentProfit(uint new_stake_profit, uint new_image_profit) internal {
		UintBalance memory unavailableProfit = getUnavailableProfit();
		recent_profit.stake = unavailableProfit.stake + new_stake_profit;
		recent_profit.image = unavailableProfit.image + new_image_profit;
		recent_profit_ts = block.timestamp;
	}
	

//	event Gas(uint left, uint consumed);

	function claim(string memory txid, uint32 txts, uint amount, int reward, string memory sender_address, address payable recipient_address, string memory data) onlyManager nonReentrant external {
		uint initial_gas = gasleft();
	//	emit Gas(initial_gas, 0);
		require(reward >= 0, "negative reward");
		uint claim_num = Import(bridgeAddress).last_claim_num() + 1;
		uint required_stake = Import(bridgeAddress).getRequiredStake(amount);
		uint paid_amount = amount - uint(reward);
		require(required_stake < uint(type(int).max), "required_stake too large");
		require(paid_amount < uint(type(int).max), "paid_amount too large");
		
		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, 0, false);
		require(net_balance.stake > 0, "no net balance in stake asset");
		require(net_balance.image > 0, "no net balance in image asset");
		require(required_stake <= uint(net_balance.stake), "not enough balance in stake asset");
		require(paid_amount <= uint(net_balance.image), "not enough balance in image asset");
		balance_in_work.stake += required_stake;

		emit NewClaimFor(claim_num, recipient_address, txid, txts, amount, reward, required_stake);

		Import(bridgeAddress).claim{value: tokenAddress == address(0) ? required_stake : 0}(txid, txts, amount, reward, required_stake, sender_address, recipient_address, data);

		(uint num, uint den) = getOraclePriceOfNative(); // price of ETH in terms of stake token
		uint remaining_gas = gasleft();
	//	emit Gas(remaining_gas, initial_gas - remaining_gas);
		uint network_fee = getGasCostInStakeTokens(
			initial_gas - remaining_gas 
			+ 91008 // entry and exit gas (it's larger when the initial network_fee_compensation is 0)
			+ (tokenAddress == address(0) ? 120000 : 120000), // withdrawal gas
			num, den
		);
		// use the AMM pool price of stake asset in terms of image asset
		uint network_fee_in_image_asset = network_fee * uint(net_balance.image) / uint(net_balance.stake);
		require(uint(reward) > network_fee_in_image_asset, "network fee would exceed reward");
		network_fee_compensation += network_fee;
		balances_in_work[claim_num] = UintBalance({stake: required_stake, image: paid_amount + network_fee_in_image_asset});
		balance_in_work.image += paid_amount + network_fee_in_image_asset;
	}

	function challenge(uint claim_num, CounterstakeLibrary.Side stake_on, uint stake) onlyManager nonReentrant external {
		uint initial_gas = gasleft();
		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, 0, false);
		require(net_balance.stake > 0, "no net balance");

		uint missing_stake = Import(bridgeAddress).getMissingStake(claim_num, stake_on);
		if (stake == 0 || stake > missing_stake) // send the stake without excess as we can't account for it
			stake = missing_stake;

		require(stake <= uint(net_balance.stake), "not enough balance");
		Import(bridgeAddress).challenge{value: tokenAddress == address(0) ? stake : 0}(claim_num, stake_on, stake);
		emit AssistantChallenge(claim_num, stake_on, stake);
		
		(uint num, uint den) = getOraclePriceOfNative(); // price of ETH in terms of stake token
		uint remaining_gas = gasleft();
	//	emit Gas(remaining_gas, initial_gas - remaining_gas);
		uint network_fee = getGasCostInStakeTokens(initial_gas - remaining_gas + 71641 - 15000, num, den);
		network_fee_compensation += network_fee;
		balances_in_work[claim_num].stake += stake + network_fee;
		balance_in_work.stake += stake + network_fee;
	}

	receive() external payable onlyETH {
		// silently receive Ether from claims
	}

	function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
		return interfaceId == type(CounterstakeReceiver).interfaceId || super.supportsInterface(interfaceId);
	}

	function onReceivedFromClaim(uint claim_num, uint claimed_amount, uint won_stake, string memory, address, string memory) onlyBridge override external {

		UintBalance storage invested = balances_in_work[claim_num];
		require(invested.stake > 0, "BUG: I didn't stake in this claim?");

		receiveFromClaim(claim_num, claimed_amount, won_stake, invested);
	}

	function receiveFromClaim(uint claim_num, uint claimed_amount, uint won_stake, UintBalance storage invested) private {
		updateMFAndGetBalances(won_stake, claimed_amount, true); // this is already added to our balance

		uint stake_profit;
		if (won_stake >= invested.stake){
			stake_profit = won_stake - invested.stake;
			require(stake_profit < uint(type(int).max), "stake profit too large");
			profit.stake += int(stake_profit);
		}
		else { // avoid negative values
			uint loss = invested.stake - won_stake;
			require(loss < uint(type(int).max), "stake loss too large");
			profit.stake -= int(loss);
		}

		uint image_profit;
		if (claimed_amount >= invested.image){
			image_profit = claimed_amount - invested.image;
			require(image_profit < uint(type(int).max), "image profit too large");
			profit.image += int(image_profit);
		}
		else { // avoid negative values
			uint loss = invested.image - claimed_amount;
			require(loss < uint(type(int).max), "image loss too large");
			profit.image -= int(loss);
		}

		addRecentProfit(stake_profit, image_profit);

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
		require(invested.stake >= my_losing_stake, "BUG: losing stake mismatch"); // >= due to network fee

		require(invested.stake < uint(type(int).max), "stake loss too large");
		require(invested.image < uint(type(int).max), "image loss too large");
		profit.stake -= int(invested.stake);
		profit.image -= int(invested.image);

		balance_in_work.stake -= invested.stake;
		balance_in_work.image -= invested.image;
		delete balances_in_work[claim_num];
	}

	// Record a win, called by anybody.
	// Should be called only if I missed onReceivedFromClaim (e.g. due to out-of-gas error).
	function recordWin(uint claim_num) nonReentrant external {

		UintBalance storage invested = balances_in_work[claim_num];
		require(invested.stake > 0, "this claim is already accounted for");
		
		CounterstakeLibrary.Claim memory c = Import(bridgeAddress).getClaim(claim_num);
		require(c.amount > 0, "no such claim");
		require(c.finished, "not finished yet");
		CounterstakeLibrary.Side opposite_outcome = c.current_outcome == CounterstakeLibrary.Side.yes ? CounterstakeLibrary.Side.no : CounterstakeLibrary.Side.yes;
		
		uint my_winning_stake = Import(bridgeAddress).stakes(claim_num, c.current_outcome, address(this));
		require(my_winning_stake == 0, "my winning stake is not cleared yet");
		
		uint my_losing_stake = Import(bridgeAddress).stakes(claim_num, opposite_outcome, address(this));
		my_winning_stake = invested.stake - my_losing_stake; // restore it
		require(my_winning_stake > 0, "I didn't stake on the winning side");
		
		uint winning_stake = c.current_outcome == CounterstakeLibrary.Side.yes ? c.yes_stake : c.no_stake;
		uint won_stake = (c.yes_stake + c.no_stake) * my_winning_stake / winning_stake;
		uint claimed_amount = (c.claimant_address == address(this) && c.current_outcome == CounterstakeLibrary.Side.yes) ? c.amount : 0;

		receiveFromClaim(claim_num, claimed_amount, won_stake, invested);
	}


	// share issue/redeem functions

	function buyShares(uint stake_asset_amount, uint image_asset_amount) payable nonReentrant external {
		if (tokenAddress == address(0))
			require(msg.value == stake_asset_amount, "wrong amount received");
		else {
			require(msg.value == 0, "don't send ETH");
			IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), stake_asset_amount);
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

		UintBalance memory unavailable_balance = getUnavailableProfit();
		require(uint(net_balance.stake) > unavailable_balance.stake, "net balance too small in stake asset");
		require(uint(net_balance.image) > unavailable_balance.image, "net balance too small in image asset");
		net_balance.stake -= int(unavailable_balance.stake);
		net_balance.image -= int(unavailable_balance.image);
		
		require(uint(net_balance.stake) > balance_in_work.stake, "negative risk-free net balance in stake asset");
		require(uint(net_balance.image) > balance_in_work.image, "negative risk-free net balance in image asset");

		// we charge a swap fee from redemptions, otherwise we leave an opportunity of free swaps by buying and instantly redeeming shares
		
		uint stake_asset_amount = (uint(net_balance.stake) - balance_in_work.stake) * (old_shares_supply**exponent - (old_shares_supply - shares_amount)**exponent) / old_shares_supply**exponent;
		stake_asset_amount -= stake_asset_amount * (swap_fee10000 + exit_fee10000)/10000;

		uint image_asset_amount = (uint(net_balance.image) - balance_in_work.image) * (old_shares_supply**exponent - (old_shares_supply - shares_amount)**exponent) / old_shares_supply**exponent;
		image_asset_amount -= image_asset_amount * (swap_fee10000 + exit_fee10000)/10000;
		
		payStakeTokens(msg.sender, stake_asset_amount);
		payImageTokens(msg.sender, image_asset_amount);
	}


	// swapping finctions

	function swapImage2Stake(uint image_asset_amount, uint min_amount_out) nonReentrant external {
		require(IERC20(bridgeAddress).transferFrom(msg.sender, address(this), image_asset_amount), "failed to pull image");

		(, IntBalance memory net_balance) = updateMFAndGetBalances(0, image_asset_amount, false);
		require(net_balance.stake > 0, "negative net balance in stake asset");
		require(net_balance.image > 0, "negative net balance in image asset");
		require(uint(net_balance.stake) > balance_in_work.stake, "negative risk-free net balance in stake asset");

		uint stake_asset_amount = (uint(net_balance.stake) - balance_in_work.stake) * image_asset_amount / (uint(net_balance.image) + image_asset_amount);
		stake_asset_amount -= stake_asset_amount * swap_fee10000/10000;
		require(stake_asset_amount >= min_amount_out, "would be less than min");

		payStakeTokens(msg.sender, stake_asset_amount);
	}

	function swapStake2Image(uint stake_asset_amount, uint min_amount_out) payable nonReentrant external {
		if (tokenAddress == address(0))
			require(msg.value == stake_asset_amount, "wrong amount received");
		else {
			require(msg.value == 0, "don't send ETH");
			IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), stake_asset_amount);
		}

		(, IntBalance memory net_balance) = updateMFAndGetBalances(stake_asset_amount, 0, false);
		require(net_balance.stake > 0, "negative net balance in stake asset");
		require(net_balance.image > 0, "negative net balance in image asset");
		require(uint(net_balance.image) > balance_in_work.image, "negative risk-free net balance in image asset");

		uint image_asset_amount = (uint(net_balance.image) - balance_in_work.image) * stake_asset_amount / (uint(net_balance.stake) + stake_asset_amount);
		image_asset_amount -= image_asset_amount * swap_fee10000/10000;
		require(image_asset_amount >= min_amount_out, "would be less than min");

		payImageTokens(msg.sender, image_asset_amount);
	}


	// manager functions

	function withdrawManagementFee() onlyManager nonReentrant external {
		updateMFAndGetBalances(0, 0, true);
		payStakeTokens(msg.sender, mf.stake + network_fee_compensation);
		payImageTokens(msg.sender, mf.image);
		mf.stake = 0;
		mf.image = 0;
		network_fee_compensation = 0;
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

	// zero address is not allowed
    function assignNewManager(address newManager) onlyManager external {
		require(newManager != address(0), "zero address");
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

		governance.addVotedValue("profit_diffusion_period", votedValueFactory.createVotedValueUint(governance, profit_diffusion_period, this.validateProfitDiffusionPeriod, this.setProfitDiffusionPeriod));
		governance.addVotedValue("swap_fee10000", votedValueFactory.createVotedValueUint(governance, swap_fee10000, this.validateSwapFee, this.setSwapFee));
		governance.addVotedValue("exit_fee10000", votedValueFactory.createVotedValueUint(governance, exit_fee10000, this.validateExitFee, this.setExitFee));
	}


	function validateProfitDiffusionPeriod(uint _profit_diffusion_period) pure external {
		require(_profit_diffusion_period <= 365 days, "profit diffusion period too long");
	}

	function setProfitDiffusionPeriod(uint _profit_diffusion_period) onlyVotedValueContract external {
		profit_diffusion_period = _profit_diffusion_period;
	}


	function validateSwapFee(uint _swap_fee10000) pure external {
		require(_swap_fee10000 < 10000, "bad swap fee");
	}

	function setSwapFee(uint _swap_fee10000) onlyVotedValueContract external {
		swap_fee10000 = uint16(_swap_fee10000);
	}

	function validateExitFee(uint _exit_fee10000) pure external {
		require(_exit_fee10000 < 10000, "bad exit fee");
	}

	function setExitFee(uint _exit_fee10000) onlyVotedValueContract external {
		exit_fee10000 = uint16(_exit_fee10000);
	}


	// helper functions

	function getOraclePriceOfNative() view private returns (uint, uint) {
		if (tokenAddress == address(0))
			return (1, 1);
		address oracleAddr = Import(bridgeAddress).oracleAddress();
		(uint num, uint den) = IOracle(oracleAddr).getPrice("_NATIVE_", IERC20WithSymbol(tokenAddress).symbol());
		require(num > 0, "price num must be positive");
		require(den > 0, "price den must be positive");
		return (num, den);
	}

	function getGasCostInStakeTokens(uint gas, uint num, uint den) view internal returns (uint) {
	//	(uint num, uint den) = getOraclePriceOfNative(); // price of ETH in terms of stake token
		return gas * tx.gasprice * num/den;
	}

	function payStakeTokens(address to, uint amount) internal {
		if (tokenAddress == address(0))
			payable(to).transfer(amount);
		else
			IERC20(tokenAddress).safeTransfer(to, amount);
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

