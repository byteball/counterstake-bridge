# Counterstake assistant and watchdog

Run this bot to assist users with cross-chain transfers facilitated by [counterstake protocol](https://counterstake.org) and earn assistant rewards (initially, 1%) on each transfer.

The bot also serves as watchdog. It monitors the ongoing transfers and if it sees a fraudulent claim or challenge, it sends a counterstake looking to win the stake posted by the fraudulent claim or challenge. The potential ROI is 66.7%. See [how counterstake works](https://counterstake.org/how-it-works).

Currently, the bot supports transfers between Obyte, Ethereum, and BSC.

The are no guarantees of the correct operation of the software. There might be bugs which can lead to losing money. Use at your own risk.

## Requirements
nodejs 12+

## Install
Get the repo:
```bash
git clone https://github.com/byteball/counterstake-bridge
cd counterstake-bridge
yarn
```
Compile the Ethereum contracts:
```bash
cd evm
npm install -g truffle
truffle compile
```

## Run
```bash
node run.js bridge 2>errlog
```

## Funding
When the bot starts, it prints its addresses, like this:
```
====== my single address: TNM2YRTJOANVGXMCFOH2FBVC3KYHZ4O6
```
This is your Obyte address. Fund it with GBYTE and any Obyte tokens that users are likely to expatriate to other chains. Larger balances will enable you to serve larger transfers and win competition against other assistant bots.
```
====== my Ethereum address:  0xEA6D65BAE2E0dDF1A3723B139cb989FAbCD63318
```
This is your Ethereum address. Fund it with ETH and any ERC20 tokens that users are likely to expatriate to other chains. Larger balances will enable you to serve larger transfers and win competition against other assistant bots.
```
====== my BSC address:  0xEA6D65BAE2E0dDF1A3723B139cb989FAbCD63318
```
This is your BSC address. Fund it with BNB and any BEP20 tokens that users are likely to expatriate to other chains. Larger balances will enable you to serve larger transfers and win competition against other assistant bots.

Larger balances also allow you to serve more transfers in parallel before your bot's capacity is exhausted.

Next, to be able to assist users with expatriations, you need to fund the bot with imported tokens on foreign chains. To do that, transfer some tokens to your bot via [counterstake.org](https://counterstake.org) by specifying your bot's address as the recipient. E.g. transfer GBYTE from Obyte to your bot's Ethereum address, transfer ETH and USDC from Ethereum to your bot's Obyte address, and so on. Note that the challenging period is 3 days by default, therefore the imported tokens will be available to your bot only after 3 days. If you want to top up the bot's balances in the future, plan that in advance as the transfer will take 3 days again.

You can track the bot's balances through the explorers on the respective chains.

## Email notifications
If the bot complains about `admin_email` and `from_email`, specify them in ~/.config/counterstake-bridge/conf.json. In case of any issues, you'll get notifications to `admin_email`.

Add `check_daemon.js` to your crontab. See `crontab.txt` for the line to be added to your crontab. If your crontab is empty, just run
```bash
crontab crontab.txt
```
You'll receive notifications to your `admin_email` if the bot crashes.

Check that the notifications work before leaving the bot to run in production. For this, kill the bot and run
```bash
node check_daemon.js
```
You should receive an email that the bot is down.

If `sendmail` is not setup and configured on your system (usually, it isn't), add the following settings to your conf.json to send emails through an external SMTP server instead:
```json
	"smtpTransport": "relay",
	"smtpRelay": "<SMTP server such as smtp.gmail.com>",
	"smtpUser": "<your account at this mail server>",
	"smtpPassword": "<your password for SMTP authentication>"
```

## Configuration
Check `conf.js` for the available options. You can override them in your conf.json. The most important ones are:
* `infura_project_id`: your infura project ID. Sign up at infura to get it.
* `alchemy_keys`: your alchemy keys. Sign up at alchemy to get them. The format is like
```json
	"alchemy_keys": {
		"polygon": {
			"mainnet": "<your mainnet key>",
			"testnet": "<your testnet key>"
		}
	},
```
* `min_reward_ratio`: minimum net reward (net of gas fees) that your bot expects to earn for assisting a transfer. The bot will ignore the transfers that pay a lower reward. Default 0.005 (0.5%).
* `max_exposure`: max share of the bot's balance in a specific token that can be sent in a counterstake against a fraudulent claim a challenge. This limits the risk you are taking. Default 0.5 (50%).
* `evm_min_transfer_age`: minimum age (in seconds) of the transfer on an EVM-based source chain before it is deemed irreversible and safe to claim on the destination chain. The default is 300 seconds (5 minutes). You can set a lower value to make sure your bot claims a transfer before other assistant bots but this also increases the risk that the transfer will be reverted and your bot will lose money.
* `evm_count_blocks_for_finality`: if your bot sees a new claim for a transfer sent from an EVM-based chain but can't find the transfer, and its timestamp is earlier than that of the block `evm_count_blocks_for_finality` blocks ago, then the bot will think that the transfer doesn't exist and will counterstake against the claim. Otherwise, the bot will wait for a few more blocks and check again if the tranfer has appeared in the source chain. The default is 20 blocks. Set a lower value to make sure that your bot counterstakes earlier than other watchdogs but this also increases the risk that the transfer will still appear in the source chain and your bot will lose money.
* `bLight`: whether to run the bot as a light Obyte node. Default `true`. Running a full node allows the bot to see new transactions slightly faster and is also more secure as the bot doesn't need to trust any external sources. However a full node takes a lot more disk space and its initial sync takes several days.
* `socksHost` and `socksPort`: host and port for connecting to TOR proxy. By default, the bot is configured to connect to Obyte nodes through TOR. To disable TOR, set `socksHost` to `null`.
* `control_addresses`: array of device addresses of your Obyte wallets (usually GUI wallets) that are allowed to view and withdraw balances using chatbot interface.
* `payout_addresses`: associative array of your withdrawal addresses keyed by network.

## Running as a pooled assistant
If the bot notices that a pooled assistant has been created for a specific bridge and the bot's address is set as the manager, the bot will start using the pool's money for claiming and counterstaking on that bridge when sufficient funds are available.

There is no UI for contributing to the pools yet, so this is not a real option at the moment.

## Managing the bot and withdrawing funds
When the bot starts, it prints its pairing code, like this:
```
====== my pairing code: AzA8qzvoMEnf7vVyo4YCw7u/hIiDOb8APpTmIPttP/29@obyte.org/bb-test#0000
```
Use this code to pair your GUI wallet with the bot and manage it through chat interface.

Set `control_addresses` in your conf.json to let the bot know who is allowed to manage it (by default, nobody is allowed). Set your `payout_addresses` addresses to enable withdrawals to your Obyte, Ethereum, and other addresses (by default, withdrawals are disabled), like this:
```
        "payout_addresses": {
                "Obyte": "EJC4A7WQGHEZEKW6RLO7F26SAR4LAQBU",
                "Ethereum": "0xbd2C1400eA794D837669d3A83Ef8B3534579b5BF"
        },
```

Type `help` in chat to see the available commands. In particular, you can use `balances` command to view the bot's balances in all currencies, `deposit` to add funds, `withdraw` to withdraw funds from the bot's balance to your payout addresses.

## Adding new bridges
See `setup_bridges.js` and edit `setupAdditionalBridge()` as appropriate.

## Adding new chains
To add a new EVM-based chain, see the source code of `ethereum.js` and `bsc.js`, add a similar class, and use it in `transfers.js`. Edit and run `emv/deploy-contracts.js` to deploy the contracts.

To add a new Obyte-based chain, see `obyte.js` and define a descendant class, then use it in `transfers.js`. Edit and run `deploy-aas.js` to deploy the autonomous agents.

To add a chain that is neither EVM-based nor Obyte-based, develop its programmable agents (such as autonomous agents on Obyte, smart contracts on Ethereum, chaincode on Hyperledger Fabric) that implement the Counterstake protocol, write a class similar to `obyte.js` and `evm-chain.js`, use it in `transfers.js`, and deploy the agents.

In all cases, you are welcome to submit PRs to add your work to this repo.

## Running automated tests on autonomous agents
```bash
yarn test aas/test
```

## Running automated tests on smart contracts
Install and run Ganache. If using a command-line version of Ganache (ganache-cli), run it on port 7545 (the default is 8545). Then run
```bash
cd evm
truffle test
```

