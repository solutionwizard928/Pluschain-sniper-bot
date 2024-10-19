const { kirkABI } = require("./constants");

const Web3 = require("web3").default;
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const { default: axios } = require("axios");
dotenv.config();

const pulseProvider = process.env.PLUSRPCURL;
const kirkContract = process.env.KIRK_CONTRACT_ADDRESS;

async function GetKirtNFTBalance(
  _address,
  contractAddress = kirkContract,
  _pulseProvider = pulseProvider,
) {
  try {
    let address = _address;
    if (_address.length > 42) address = await pk2Address(_address);

    const web3 = new Web3(new Web3.providers.HttpProvider(_pulseProvider));
    const tokenContract = new web3.eth.Contract(kirkABI, contractAddress);
    const tokenBalance = await tokenContract.methods
      .tokensOfOwner(address)
      .call();
    return tokenBalance.map((_nft) =>
      Number(ethers.formatUnits(_nft.toString(), 0)),
    );
  } catch (error) {
    console.log(error);
    return [];
  }
}

async function withdrawKirk(pk, toAddress) {
  const kirkOwnerAddress = await pk2Address(pk);
  const _kirkBalance = await GetKirtNFTBalance(kirkOwnerAddress);

  const web3 = new Web3(new Web3.providers.HttpProvider(pulseProvider));
  const tokenContract = new web3.eth.Contract(kirkABI, kirkContract);
  const signer = web3.eth.accounts.privateKeyToAccount(pk);
  web3.eth.accounts.wallet.add(signer);
  let withdrawTxs = [];
  for (let i = 0; i < _kirkBalance.length; i++) {
    const tx = await tokenContract.methods
      .safeTransferFrom(kirkOwnerAddress, toAddress, _kirkBalance[i])
      .send({
        from: signer.address,
        gas: 100000,
      });
    if (tx.transactionHash) withdrawTxs.push(tx.transactionHash);
  }
  return withdrawTxs;
}

async function pk2Address(pk, _pulseProvider = pulseProvider) {
  try {
    const web3 = new Web3(new Web3.providers.HttpProvider(_pulseProvider));
    if (pk.slice(0, 2) !== "0x") pk = "0x" + pk;
    const { address } = web3.eth.accounts.privateKeyToAccount(pk);
    return address;
  } catch (error) {
    console.log(error);
    return "";
  }
}

async function GetPulseUSDPrice() {
  try {
    const solUsd = await axios
      .get(
        "https://api.coinmarketcap.com/dexer/v3/platformpage/pair-pages?platform-id=189&dexer-id=7126&sort-field=txns24h&category=spot&page=1",
      )
      .then((res) =>
        res.data.data.pageList.find(
          (token) =>
            token.pairContractAddress ===
            "0xe56043671df55de5cdf8459710433c10324de0ae",
        ),
      )
      .then((token) => Number(token.priceUsd));
    return solUsd;
  } catch (error) {
    console.log(error);
    return 0;
  }
}
module.exports = {
  GetKirtNFTBalance,
  pk2Address,
  withdrawKirk,
  GetPulseUSDPrice,
};
