const { erc20abi, QUICKVABI } = require("./constants");

const Web3 = require("web3").default;
const { ethers } = require("ethers");
const dotenv = require("dotenv");
const { withdrawPulse } = require("./pulseWallet");
dotenv.config();

const pulseProvider = process.env.PLUSRPCURL;
const nativeToken = process.env.NATIVETOKEN;
const ownerAddress = process.env.OWNER_ADDRESS;
const revenueFee = process.env.REVENUE_FEE;
async function swapPulse(
  _pulseProvider = pulseProvider,
  pk,
  swapContractAddress,
  fromToken,
  toToken,
  amount,
  isMax = false,
) {
  try {
    const web3 = new Web3(new Web3.providers.HttpProvider(_pulseProvider));
    if (pk.slice(0, 2) !== "0x") pk = "0x" + pk;
    const { address } = web3.eth.accounts.privateKeyToAccount(pk);
    const gasPrice = await web3.eth.getGasPrice();

    let tokenContract;
    if (toToken === nativeToken) {
      const before_balance = await web3.eth.getBalance(address);
      tokenContract = new web3.eth.Contract(erc20abi, fromToken);
      const tokenBalance = await tokenContract.methods
        .balanceOf(address)
        .call();

      console.log(tokenBalance);

      console.log("users token balance", tokenBalance);
      const allowanceAmount = await tokenContract.methods
        .allowance(address, swapContractAddress)
        .call();
      console.log("users allowanceAmount", allowanceAmount);
      const decimals = await tokenContract.methods.decimals().call();
      //const { medium_gas_price } = await estimateGasPrice();
      let tokenAmount = tokenBalance;
      if (!isMax) {
        if (
          Number(ethers.formatUnits(tokenBalance.toString(), decimals)) <
          Number(amount)
        ) {
          console.log("Insufficient Token Balance !");
          return { status: false, code: 0, tx: "" };
        }
        tokenAmount = ethers.parseUnits(
          amount.toFixed(Number(decimals.toString())),
          decimals,
        );
      }

      if (Number(ethers.formatUnits(tokenBalance.toString(), decimals)) === 0)
        return { status: false, code: 0, tx: "" };

      const _tbalance = Number(
        ethers.formatUnits(tokenAmount.toString(), decimals),
      );
      const _aAllowance = Number(
        ethers.formatUnits(allowanceAmount.toString(), decimals),
      );
      if (_tbalance === 0) {
        console.log("zero,");
        return { status: false, code: 0, tx: "" };
      }
      if (_tbalance > _aAllowance) {
        console.log("token balance is bigger than allowance ones");
        const contractApprove = new web3.eth.Contract(erc20abi, fromToken, {
          from: address,
        });

        const signer = web3.eth.accounts.privateKeyToAccount(pk);
        web3.eth.accounts.wallet.add(signer);
        const nonce = await web3.eth.getTransactionCount(signer.address);
        await contractApprove.methods
          .approve(swapContractAddress, web3.utils.toBigInt(tokenAmount))
          .send({
            from: signer.address,
            gas: 500000,
            nonce,
          });
      }

      const signer = web3.eth.accounts.privateKeyToAccount(pk);
      web3.eth.accounts.wallet.add(signer);
      const contractETH = new web3.eth.Contract(
        QUICKVABI,
        swapContractAddress,
        { from: address },
      );
      // const nonce = await web3.eth.getTransactionCount(signer.address);

      return await contractETH.methods
        .swapExactTokensForETHSupportingFeeOnTransferTokens(
          web3.utils.toBigInt(tokenAmount),
          0,
          [fromToken, toToken],
          address,
          Math.floor(Date.now() / 1000) + 60 * 20,
        )
        .send({
          from: signer.address,
          gas: 500000,
          // nonce,
          maxPriorityFeePerGas: gasPrice,
        })
        .then(async (res) => {
          const after_balance = await web3.eth.getBalance(address);
          const get_pls =
            Number(ethers.formatEther(before_balance.toString())) -
            Number(ethers.formatEther(after_balance.toString()));
          await withdrawPulse(pk, ownerAddress, (get_pls * revenueFee) / 100);
          return {
            status: true,
            code: 200,
            tx: res.transactionHash,
            amount: ethers.formatEther(tokenAmount.toString(), decimals),
          };
        });
    } else {
      const signer = web3.eth.accounts.privateKeyToAccount(pk);
      const _balance = await web3.eth.getBalance(signer.address);
      if (Number(_balance) < Number(amount)) {
        console.log(
          "Insufficient amount rejected, your balance is ",
          _balance,
          " pls. but you required ",
          amount,
          " pls",
        );
      }
      amount = ethers.parseUnits(amount.toString(), 18);

      web3.eth.accounts.wallet.add(signer);
      const contractETH = new web3.eth.Contract(
        QUICKVABI,
        swapContractAddress,
        { from: address },
      );

      return await contractETH.methods
        .swapExactETHForTokensSupportingFeeOnTransferTokens(
          0,
          [fromToken, toToken],
          address,
          Math.floor(Date.now() / 1000) + 60 * 20,
        )
        .send({
          from: signer.address,
          gas: 500000,
          value: web3.utils.toBigInt(amount),
          //maxFeePerGas: gasPrice * 2n,
          maxPriorityFeePerGas: gasPrice,
        })
        .then(async (res) => {
          await withdrawPulse(
            pk,
            ownerAddress,
            (Number(ethers.formatEther(amount.toString())) * revenueFee) / 100,
          );
          return {
            status: true,
            code: 200,
            tx: res.transactionHash,
            amount: ethers.formatEther(amount.toString()),
          };
        });
    }
  } catch (error) {
    console.log(error);
    return { status: false, code: 500, tx: "" };
  }
}

module.exports = {
  pulseProvider,
  swapPulse,
};
async function test() {
  const result = await swapPulse(
    pulseProvider,
    process.env.PLUSPK,
    process.env.PULSEROUTER,
    nativeToken,
    "0xAD791B360408Ff886313caD78AC9D1D00bf36f3E",
    100,
  );

  //const result = await swapPulse(pulseProvider, process.env.PLUSPK, process.env.PULSEROUTER, "0x6C2B1644EFb0Fa9338dbdd4197D4533b9c6d17f7", nativeToken, 500, true)
  console.log(result);
}

// test()
