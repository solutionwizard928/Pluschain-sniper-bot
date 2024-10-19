const { erc20abi, QUICKVABI } = require("./constants");

const Web3 = require("web3").default;
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const { default: axios } = require("axios");
dotenv.config();

const pulseProvider = process.env.PLUSRPCURL;
const nativeToken = process.env.NATIVETOKEN;

async function getBalanceNAddress(pk) {
  const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
  if (pk.slice(0, 2) !== "0x") pk = "0x" + pk;
  const signer = web3.eth.accounts.privateKeyToAccount(pk);
  const _balance = await web3.eth.getBalance(signer.address);
  return {
    address: signer.address,
    balance: ethers.formatUnits(_balance.toString(), 18),
  };
}

async function withdrawPulse(pk, toAddress, amount) {
  try {
    const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
    if (pk.slice(0, 2) !== "0x") pk = "0x" + pk;
    const signer = web3.eth.accounts.privateKeyToAccount(pk);
    const amountInWei = web3.utils.toWei(amount.toString(), "ether");

    // Get the transaction count, which is needed for the nonce
    const txCount = await web3.eth.getTransactionCount(signer.address);
    const gasPrice = await web3.eth.getGasPrice();

    // Create the transaction object
    const txObject = {
      nonce: txCount,
      to: toAddress,
      value: amountInWei,
      gas: 100000,
      maxFeePerGas: gasPrice * 2n,
      maxPriorityFeePerGas: ethers.parseUnits("5000", 9),
    };

    // Sign the transaction with the private key
    const signedTx = await web3.eth.accounts.signTransaction(txObject, pk);

    // Send the signed transaction
    const receipt = await web3.eth.sendSignedTransaction(
      signedTx.rawTransaction,
    );

    return receipt.transactionHash;
  } catch (e) {
    console.log(e);
    return false;
  }
}

async function getTokenName(tokenAddress) {
  const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
  const tokenContract = new web3.eth.Contract(erc20abi, tokenAddress);
  try {
    return await tokenContract.methods.name().call();
  } catch (error) {
    return false;
  }
}

async function getTokenSymbol(tokenAddress) {
  const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
  const tokenContract = new web3.eth.Contract(erc20abi, tokenAddress);
  try {
    return await tokenContract.methods.symbol().call();
  } catch (error) {
    return false;
  }
}

async function getTokenBalance(tokenAddress, userAddress) {
  const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
  const tokenContract = new web3.eth.Contract(erc20abi, tokenAddress);
  try {
    const balance = await tokenContract.methods.balanceOf(userAddress).call();
    const decimals = await tokenContract.methods.decimals().call();
    const formattedBalance = Number(
      ethers.formatUnits(balance.toString(), Number(decimals)),
    ); // Convert balance to a readable format if needed
    return formattedBalance;
  } catch (error) {
    return 0;
  }
}

async function getAllTokenBalances(userAddress) {
  try {
    const _balances = await axios
      .get(
        `https://api.scan.pulsechain.com/api/v2/addresses/${userAddress}/token-balances`,
      )
      .then((res) => res.data)
      .catch(() => []);
    return _balances.map((_token) => ({
      address: _token.token.address,
      name: _token.token.name,
      symbol: _token.token.symbol,
      ui_value: ethers.formatUnits(_token.value, Number(_token.token.decimals)),
    }));
  } catch (error) {
    return [];
  }
}

module.exports = {
  getBalanceNAddress,
  withdrawPulse,
  getTokenName,
  getTokenSymbol,
  getTokenBalance,
  getAllTokenBalances,
};
