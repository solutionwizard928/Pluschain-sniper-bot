const dotenv = require("dotenv");
dotenv.config();
const { Telegraf } = require("telegraf");
const commaNumber = require("comma-number");
const bot = new Telegraf(process.env.PULSE_TG_BOT_KEY, {
  handlerTimeout: 9_000_000,
});
const colors = require("colors");
const humanizeDuration = require("humanize-duration");
const { readFileSync, writeFileSync, stat } = require("fs");
const Wallet = require("ethereumjs-wallet").default;
const thumbnailJPG = "./thumbnail.jpg";
colors.setTheme({
  silly: "rainbow",
  input: "grey",
  verbose: "cyan",
  prompt: "grey",
  info: "green",
  data: "grey",
  help: "cyan",
  warn: "yellow",
  debug: "blue",
  error: "red",
});
const WebSocket = require("ws");
const axios = require("axios");
const { swapPulse } = require("./pulseSwap");
const {
  getBalanceNAddress,
  withdrawPulse,
  getTokenName,
  getTokenSymbol,
  getTokenBalance,
  getAllTokenBalances,
} = require("./pulseWallet");
const {
  GetKirtNFTBalance,
  pk2Address,
  withdrawKirk,
  GetPulseUSDPrice,
} = require("./kirkScript");
const { report } = require("process");

const millify = (data) => {
  return commaNumber(data);
};
const pulseProvider = process.env.PLUSRPCURL;
const nativeToken = process.env.NATIVETOKEN;
const pulseRouter = process.env.PULSEROUTER;
const pulseScanURL = process.env.PULSESCAN_URL;
const userfilePath = "user.json";
let isBotStop = false;
let TargetTokens = {};
let CurrentRisingToken = [];
let SellExcludedTokens = [];
let tokenHistory;
let PairsFromIO = [];
let TradingTokensX = {};
let RetryingSell = {};
let RetryingBuy = {};
let limitTradeX = 2;
let USERS = {};
let SETTINGS = {
  admins: process.env.TG_ADMINS.split(","),
};
const retryInterval = 5000;

const wsconnect = () => {
  const headers = {
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en,en-US;q=0.9",
    "Cache-Control": "no-cache",
    Connection: "Upgrade",
    Host: "io.dexscreener.com",
    Origin: "https://dexscreener.com",
    Pragma: "no-cache",
    "Sec-Websocket-Extensions": "permessage-deflate; client_max_window_bits",
    "Sec-Websocket-Key": "G+37bHwatB7JHscz+glk9w==",
    "Sec-Websocket-Version": "13",
    Upgrade: "websocket",
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
  };
  // Create a new WebSocket instance and specify the server URL
  const ws = new WebSocket(
    "wss://io.dexscreener.com/dex/screener/pairs/h24/1?rankBy[key]=pairAge&rankBy[order]=asc&filters[chainIds][0]=pulsechain&filters[dexIds][0]=pulsex",
    { headers },
  );
  // Event listener for when the connection is established
  ws.on("open", () => {
    console.log("Connected to WebSocket server");
  });

  ws.on("message", (data) => {
    const parsedData = JSON.parse(data);
    if (parsedData === "ping") {
      //console.log(colors.warn('Reconnecting ws'))
      ws.send("pong");
    } else {
      const { pairs = [] } = parsedData;
      const onlyPulsePairs = pairs.filter((pair) => pair.dexId === "pulsex");
      if (onlyPulsePairs.length) {
        PairsFromIO = onlyPulsePairs;
        if (!isBotStop) handlePairData(onlyPulsePairs);
      }
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    ws.close();
  });

  ws.on("close", () => {
    console.log("Disconnected from WebSocket server");
    setTimeout(() => {
      console.log("WEBSOCKET_CLOSE: reconnecting...");
      wsconnect();
    }, retryInterval);
  });
};
wsconnect();
const NotifyBuyToken = async (user, _token, _tx, amount) => {
  const userId = Object.keys(USERS).find(
    (u) => USERS[u].wallet === user.wallet,
  );
  USERS[userId].trading_tokens.push(_token);
  TradingTokensX[user.wallet] = TradingTokensX[user.wallet].filter(
    (tk) =>
      tk.token.baseToken.address !== _token.baseToken.address ||
      tk.type != "buy",
  );
  saveUserList();
  const address = await pk2Address(user.wallet);
  const pulseBalance = await getBalanceNAddress(user.wallet);
  const token_balance = await getTokenBalance(
    _token.baseToken.address,
    address,
  );
  const reportMessage = `<b>Auto Trading</b>

Bought <b>${_token.baseToken.symbol}</b> for <b>${millify(amount)}</b> PLS at $${_token.priceUsd}

<code>${_token.baseToken.address}</code>

Your <b>${_token.baseToken.symbol}</b> balance is <b>${Number(token_balance).toFixed(3)}</b>
Your current <b>PLS</b> balance is <b>${Number(pulseBalance.balance).toFixed(3)}</b> ($${millify((Number(pulseBalance.balance) * (await GetPulseUSDPrice())).toFixed(3))})`;
  bot.telegram.sendMessage(user.chat_id, reportMessage, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "See transaction",
            url: `${pulseScanURL}/tx/${_tx}`,
          },
        ],
      ],
    },
  });
};

const NotifySellToken = async (user, _token, _tx, amount) => {
  const userId = Object.keys(USERS).find(
    (u) => USERS[u].wallet === user.wallet,
  );
  const index = USERS[userId].trading_tokens
    .flatMap((_oToken) => _oToken.baseToken.address)
    .indexOf(_token.baseToken.address);
  console.log(
    colors.warn("Sold Token"),
    `${pulseScanURL}/tx/${_tx}`,
    colors.data("Removed token from buyable list", index),
  );
  const pulseBalance = await getBalanceNAddress(user.wallet);
  const profit =
    index >= 0
      ? (Number(
          _token.priceUsd -
            Number(USERS[userId].trading_tokens[index].priceUsd),
        ) *
          100) /
        Number(USERS[userId].trading_tokens[index].priceUsd)
      : 0;
  if (!USERS[userId].total_profit) USERS[userId].total_profit = 0;
  if (!USERS[userId].transaction_count) USERS[userId].transaction_count = 0;
  USERS[userId].total_profit += profit;
  USERS[userId].transaction_count++;
  const reportMessage = `<b>Auto Trading</b>

Sold <b>${_token.baseToken.symbol}</b> for <b>${millify(amount)}</b> PLS at $${_token.priceUsd}
  
<code>${_token.baseToken.address}</code>

${index >= 0 ? `Profit: <b>${profit.toFixed(2)}</b>%` : ""}

Your current PLS balance is <b>${millify(Number(pulseBalance.balance).toFixed(3))}</b> ($${millify((Number(pulseBalance.balance) * (await GetPulseUSDPrice())).toFixed(3))})
`;
  USERS[userId].trading_tokens.splice(index);
  saveUserList();

  bot.telegram.sendMessage(user.chat_id, reportMessage, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "See transaction",
            url: `${pulseScanURL}/tx/${_tx}`,
          },
        ],
      ],
    },
  });
};
const NotifyFailedSellToken = (user, _token) => {
  const reportMessage = `<b>Auto Trading</b>

Failed Selling: Please try to sell this token manual <b>${_token.baseToken.symbol}</b>

<code>${_token.baseToken.address}</code>
`;
  bot.telegram.sendMessage(user.chat_id, reportMessage, {
    parse_mode: "HTML",
  });
};

const NotifyFailedBuyToken = (user, _token) => {
  const reportMessage = `<b>Auto Trading</b>

Failed Buying: Please try to buy this token manual <b>${_token.baseToken.symbol}</b>

<code>${_token.baseToken.address}</code>
`;
  bot.telegram.sendMessage(user.chat_id, reportMessage, {
    parse_mode: "HTML",
  });
};

const NotifyNewTokenFound = (user, _token) => {
  const reportMessage = `<b>Auto Trading</b>

New Token: 
Name: <b>${_token.baseToken.name}</b> 
Symbol: <b>${_token.baseToken.symbol}</b>
Price: <b>$${_token.priceUsd}</b>
Address: <code>${_token.baseToken.address}</code>
MarketCap: <b>$${_token.marketCap}</b>
Liquidity: <b>$${_token.liquidity?.usd}</b>
Pool: <b>$${_token.liquidity?.base}</b>
`;
  bot.telegram.sendMessage(user.chat_id, reportMessage, {
    parse_mode: "HTML",
  });
};
const handlePairData = async (onlyPulsePairs = []) => {
  const quoteBaseFilter = onlyPulsePairs.filter(
    (pair) =>
      pair.quoteToken.address.toLowerCase() === nativeToken.toLowerCase() &&
      pair.labels.includes("v2"),
  );

  const priceFilter = quoteBaseFilter.filter(
    (pair) =>
      pair.priceChange.m5 >= 0 &&
      pair.priceChange.h1 > 0 &&
      pair.priceChange.h6 > 0 &&
      pair.priceChange.h24 > 0,
  );

  const users = Object.keys(USERS).map((user) => USERS[user]);
  users.forEach((user) => {
    if (!user.trading_tokens) user.trading_tokens = [];
    if (!user.hasNFT) return;
    if (!user.bot_running) return;
    if (!user.liquidityMinLimit) user.liquidityMinLimit = 500;
    if (!user.liquidityMaxLimit) user.liquidityMaxLimit = 0;

    const removeLowLiquidity = priceFilter.filter(
      (pair) =>
        pair.liquidity.usd > user.liquidityMinLimit &&
        user.liquidityMaxLimit > 0 &&
        pair.liquidity.usd < user.liquidityMaxLimit,
    );

    const liquidityChange = removeLowLiquidity.filter((pair) => {
      if (!user.liquidityChange || !tokenHistory) {
        return true;
      }
      const prevToken = tokenHistory.find(
        (tk) => tk.baseToken.address == pair.baseToken.address,
      );
      if (!prevToken) return true;
      return (
        Number(pair.liquidity.usd) - Number(prevToken.liquidity.usd) >
        Number(user.liquidityChange)
      );
    });

    CurrentRisingToken = liquidityChange.filter(
      (pair) => pair.pairCreatedAt >= Date.now() - 60 * 1000,
    );
    new Promise(async (resolve) => {
      for (const _pToken of PairsFromIO) {
        const _isNewTargetIndex = user.trading_tokens
          .flatMap((_tToken) => _tToken.pairAddress)
          .indexOf(_pToken.pairAddress);
        if (_isNewTargetIndex >= 0) {
          // console.log(colors.data("Already added"), "\n")
          const boughtPrice = Number(
            user.trading_tokens[_isNewTargetIndex].priceUsd,
          );
          const currentPrice = Number(_pToken.priceUsd);
          const _profit = ((currentPrice - boughtPrice) * 100) / boughtPrice;
          console.log(colors.warn(_profit + "%"));
          if (
            _profit > Number(user.profit) ||
            (_profit < 0 && _profit < -Number(user.stopLoss))
          ) {
            console.log(
              colors.warn(
                "Current profit is over than set one" + _profit + "% selling..",
              ),
            );
            tradeFunction(user, _pToken, "sell");
          }
        }
      }

      for (const _nToken of CurrentRisingToken) {
        if (!TargetTokens[user.wallet]) TargetTokens[user.wallet] = [];
        const _isNewTargetIndex = TargetTokens[user.wallet]
          .flatMap((_tToken) => _tToken.pairAddress)
          .includes(_nToken.pairAddress);
        if (_isNewTargetIndex) {
          console.log(colors.data("Already added"));
        } else {
          TargetTokens[user.wallet].push(_nToken);
          NotifyNewTokenFound(user, _nToken);
          tradeFunction(user, _nToken, "buy");
        }
      }
      /*
      for (const _tToken of user.trading_tokens) {
        if (
          CurrentRisingToken
            .flatMap((_fToken) => _fToken.pairAddress)
            .includes(_tToken.pairAddress)
        ) {
          console.log(
            colors.data("Keep watching"),
            colors.info(_tToken.baseToken.symbol),
          );
        } else {
          console.log(
            colors.silly("Caution! Depressed token:"),
            colors.error(_tToken.baseToken.symbol),
          );

          tradeFunction(user, _tToken, "sell");
        }
      }
      */
    });
  });
  tokenHistory = quoteBaseFilter;
  //console.log(onlyPulsePairs[0])
};

const tradeFunction = (user, token, type) => {
  if (!TradingTokensX[user.wallet]) {
    TradingTokensX[user.wallet] = [];
  }
  const userId = Object.keys(USERS).find(
    (u) => USERS[u].wallet === user.wallet,
  );

  if (token) {
    if (
      TradingTokensX[user.wallet].findIndex(
        (trade) =>
          token.baseToken.address === trade.token.baseToken.address &&
          type === trade.type,
      ) == -1
    ) {
      TradingTokensX[user.wallet].push({ type, token });
    } else {
      console.log("Already executing tx", token.baseToken.symbol);
      return;
    }
  }

  if (TradingTokensX[user.wallet].length != 1) {
    return;
  }

  const next = TradingTokensX[user.wallet][0];
  const tradeTokenIndex = USERS[userId].trading_tokens.findIndex(
    (tk) => tk.baseToken.address === next.token.baseToken.address,
  );
  if (next.type == "buy") {
    if (tradeTokenIndex > -1) {
      return;
    }

    BuyAxiosFunction(user, next.token)
      .then((res) => {
        if (res.code === 500) {
          if (!RetryingBuy[next.token.baseToken.address])
            RetryingBuy[next.token.baseToken.address] = 1;
          else RetryingBuy[next.token.baseToken.address]++;
          if (RetryingBuy[next.token.baseToken.address] >= 3) {
            console.log("Reached out to 3 trying. remove this token to buy.");
            USERS[userId].trading_tokens.splice(tradeTokenIndex, 1);
            NotifyFailedBuyToken(user, next.token);
          }
        }
        TradingTokensX[user.wallet].splice(0);
        tradeFunction(user);
      })
      .catch((res) => {
        if (res.code === 500) {
          if (!RetryingBuy[next.token.baseToken.address])
            RetryingBuy[next.token.baseToken.address] = 1;
          else RetryingBuy[next.token.baseToken.address]++;
          if (RetryingBuy[next.token.baseToken.address] >= 3) {
            console.log("Reached out to 3 trying. remove this token to buy.");
            USERS[userId].trading_tokens.splice(tradeTokenIndex, 1);
            NotifyFailedBuyToken(user, next.token);
          }
        }
        TradingTokensX[user.wallet].splice(0);
        tradeFunction(user);
      });
  }
  if (next.type == "sell") {
    if (tradeTokenIndex == -1) {
      return;
    }
    SellAxiosFunction(user, next.token)
      .then((res) => {
        if (res.code === 0)
          USERS[userId].trading_tokens.splice(tradeTokenIndex, 1);
        if (res.code === 500) {
          if (!RetryingSell[next.token.baseToken.address])
            RetryingSell[next.token.baseToken.address] = 1;
          else RetryingSell[next.token.baseToken.address]++;
          if (RetryingSell[next.token.baseToken.address] >= 3) {
            console.log("Reached out to 3 trying. remove this token to sell."); //TODO notify
            USERS[userId].trading_tokens.splice(tradeTokenIndex, 1);
            NotifyFailedSellToken(user, next.token);
          }
        }

        TradingTokensX[user.wallet].splice(0);
        tradeFunction(user);
      })
      .catch((res) => {
        if (res.code === 500) {
          if (!RetryingSell[next.token.baseToken.address])
            RetryingSell[next.token.baseToken.address] = 1;
          else RetryingSell[next.token.baseToken.address]++;
          if (RetryingSell[next.token.baseToken.address] >= 3) {
            console.log("Reached out to 3 trying. remove this token to sell."); //TODO notify
            USERS[userId].trading_tokens.splice(tradeTokenIndex, 1);
            NotifyFailedSellToken(user, next.token);
          }
        }
        TradingTokensX[user.wallet].splice(0);
        tradeFunction(user);
      });
  }
};

const BuyAxiosOriginFunction = async (_tToken) => {
  return await swapPulse(
    pulseProvider,
    SETTINGS.wallet,
    pulseRouter,
    nativeToken,
    _tToken.baseToken.address,
    SETTINGS.tradeAmount,
  );
};
const BuyAxiosFunction = async (user, _nToken) => {
  const userId = Object.keys(USERS).find(
    (u) => USERS[u].wallet === user.wallet,
  );
  console.log(colors.info("Buying Token"), _nToken.baseToken.address);
  return await swapPulse(
    pulseProvider,
    user.wallet,
    pulseRouter,
    nativeToken,
    _nToken.baseToken.address,
    user.tradeAmount,
  )
    .then((res) => {
      console.log(res);
      if (res.status) {
        NotifyBuyToken(user, _nToken, res.tx, res.amount);
      } else {
        const index = USERS[userId].trading_tokens
          .flatMap((_tToken) => _tToken.pairAddress)
          .indexOf(_nToken.pairAddress);
        console.log(
          colors.error("Failed buying"),
          colors.data("Removed token from buyable list", index),
        );
      }
    })
    .catch(async (err) => {
      console.log(err);
      const index = USERS[userId].trading_tokens
        .flatMap((_tToken) => _tToken.pairAddress)
        .indexOf(_nToken.pairAddress);
      console.log(
        colors.error("Failed buying"),
        colors.data("Removed token from buyable list", index),
      );
      // if(index>-1)
      // await BuyAxiosFunction(_nToken)
    });
};
const SellAxiosOriginFunction = async (_tToken) => {
  return await swapPulse(
    pulseProvider,
    SETTINGS.wallet,
    pulseRouter,
    _tToken.baseToken.address,
    nativeToken,
    SETTINGS.tradeAmount,
    true,
  );
};
const SellAxiosFunction = async (user, _tToken) => {
  console.log(colors.warn("Selling Token"));
  const userId = Object.keys(USERS).find(
    (u) => USERS[u].wallet === user.wallet,
  );

  return await swapPulse(
    pulseProvider,
    user.wallet,
    pulseRouter,
    _tToken.baseToken.address,
    nativeToken,
    user.tradeAmount,
    true,
  )
    .then(async (res) => {
      if (res.status) {
        NotifySellToken(user, _tToken, res.tx, res.amount);
      } else {
        console.log(
          colors.error("Failed Selling"),
          colors.data("Reselling Token..."),
        );
        if (res.code === 0 && _tToken.pairCreatedAt + 60000 < Date.now()) {
          console.log(
            colors.data("No Balance detected! Retrying untill 1 min..."),
            colors.debug("Created at:"),
            colors.data(
              humanizeDuration(Date.now() - _tToken.pairCreatedAt),
              " ago",
            ),
          );
          return res;
          // await SellAxiosFunction(_tToken )
        } else if (res.code === 500) {
          console.log(colors.data("Transaction failed. retrying..."));
          return res;
          // await SellAxiosFunction(_tToken )
        }
      }
    })
    .catch(async () => {
      console.log(colors.data("Transaction failed. retrying..."));
      //await SellAxiosFunction(_tToken )
      return { code: 500 };
    });
};

const showPairData = (pairArray = []) => {
  pairArray.map((pair) => {
    console.log(
      colors.debug("Token name:"),
      colors.verbose(pair.baseToken.name),
    );
    console.log(
      colors.debug("Token symbol:"),
      colors.verbose(pair.baseToken.symbol),
    );
    console.log(
      colors.debug("Token Pair Address:"),
      colors.verbose(pair.pairAddress),
    );
    console.log(
      colors.debug("Token Address:"),
      colors.verbose(pair.baseToken.address),
    );
    console.log(colors.debug("Current Buyers:"), colors.info(pair.buyers.h24));
    console.log(
      colors.debug("Current Sellers:"),
      colors.error(pair.sellers.h24),
    );
    console.log(
      colors.debug("Created at:"),
      colors.data(humanizeDuration(Date.now() - pair.pairCreatedAt), " ago"),
    );
    console.log(colors.warn("Don't miss chance"));
  });
};
const handleHoldTokensToSell = async (_hToken, balances) => {
  try {
    const _index = PairsFromIO.flatMap(
      (_pToken) => _pToken.baseToken.address,
    ).indexOf(_hToken);
    let _tokenInfo = null;
    if (_index > 0) {
      _tokenInfo = PairsFromIO[_index];
    }
    // else {
    //   const _stokenInfo = await GetTokenInfo(_hToken);
    //   if (_stokenInfo !== null && _stokenInfo.length) {
    //     _tokenInfo = _stokenInfo[0]
    //   }
    // }
    //const _tokenInfo = await GetTokenInfo(_hToken);
    if (_tokenInfo !== null) {
      if (_tokenInfo.liquidity.usd > 500) {
        if (Number(balances[_hToken]) > 0) {
          console.log(
            colors.debug("Selling Token automatically"),
            colors.info(_hToken),
            Number(balances[_hToken]),
          );
          SellAxiosOriginFunction(_tokenInfo);
        }
      }
    }
  } catch (error) {
    console.log(error);
  }
};
const GetTokenInfo = async (_token) => {
  console.log(colors.data("Used dexscreener API"));
  return await axios
    .get(`https://api.dexscreener.com/latest/dex/tokens/${_token}`)
    .then((res) => res.data.pairs)
    .catch(() => null);
};
//make autosell function after 10s except for rising token if liquidty 1k plus.

// if buyers/buyers+sellers is more than 0.8 && sellvol/buybol+sellvol more than 0.4 there is bot
//setInterval(SellHoldTokensTimer, 1000)
function loadUserList() {
  try {
    const userListData = readFileSync(userfilePath);
    USERS = JSON.parse(userListData);
    console.log("Loaded user data");
  } catch (error) {
    saveUserList();
    console.log("Created empty user data");
  }
}

function saveUserList() {
  writeFileSync(userfilePath, JSON.stringify(USERS, null, 2), "utf8");
}
loadUserList();
bot.telegram.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "home", description: "Show main menu" },
  { command: "wallet", description: "Manage your wallet" },
  { command: "auto", description: "Auto Trade Settings" },
  { command: "buy", description: "Buy token" },
  { command: "sell", description: "Sell & Manage" },
]);

let status = {};

function initStatus(userId) {
  if (!status[userId]) {
    status[userId] = {
      withdrawing: false,
      withdraw_message_id: -1,
      isWithdrawAll: false,
      amount_message_id: -1,
      coin_address_message_id: -1,
      buying: false,
      withdraw_address: "",
      coin_address: "",
      selling: false,
      trade_amount_message_id: -1,
      stop_loss_message_id: -1,
      profit_message_id: -1,
      liquidity_min_message_id: -1,
      liquidity_max_message_id: -1,
      liquidity_change_message_id: -1,
    };
  }
  status[userId].withdrawing = false;
  status[userId].selling = false;
  status[userId].buying = false;
}

const startBot = async (ctx) => {
  try {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const isAdmin = SETTINGS.admins.includes(username);
    if (isAdmin) {
      isBotStop = false;
    }
    let address = "";
    let balance = 0.0;
    if (!USERS[userId]) {
      const addressData = Wallet.generate();
      const newPK = addressData.getPrivateKeyString();
      const newADS = addressData.getAddressString();

      USERS[userId] = {
        chat_id: ctx.message.chat.id,
        wallet: newPK,
        profit: Number(process.env.PROFIT),
        tradeAmount: Number(process.env.TRADE_AMOUNT),
        stopLoss: Number(process.env.STOP_LOSS ?? 10),
        liquidityMinLimit: Number(process.env.LIQUIDITY_MIN_LIMIT) ?? 500,
        liquidityMaxLimit: Number(process.env.LIQUIDITY_MAX_LIMIT) ?? 0,
        liquidityChange: 0,
        hasNFT: false,
        bot_running: true,
        total_profit: 0,
        transaction_count: 0,
        trading_tokens: [],
        transactions: {
          buys: [],
          sells: [],
        },
      };

      address = newADS;
      balance = 0;
    } else {
      const { address: _address, balance: _balance } = await getBalanceNAddress(
        USERS[userId].wallet,
      );
      const kirkBalance = await GetKirtNFTBalance(USERS[userId].wallet);
      USERS[userId].hasNFT = kirkBalance.length > 0;
      address = _address;
      balance = Number(_balance);
    }
    USERS[userId].chat_id = ctx.message.chat.id;
    initStatus(userId);

    if (!balance) {
      balance = 0;
    }
    const kirkBalance = await GetKirtNFTBalance(USERS[userId].wallet);
    let reportMessage = `
Welcome to KirkBot, Pulsechain’s fastest and most reliable sniper bot.
  
Your current <b>PLS</b> balance is <b>${millify(Number(balance).toFixed(3))}</b> ($${millify((Number(balance) * (await GetPulseUSDPrice())).toFixed(3))})
To add to your balance you can send some <b>PLS</b> to your pulse wallet address:
<code>${address}</code>(Tap on the address to Copy)

${
  kirkBalance.length
    ? `You have  <b>Kirk NFT #${kirkBalance.join(", #")}</b>
You can snipe from now
`
    : `You don't have any <b>Kirk NFTs</b>. Please purchase it at least one if you want to use this bot.`
}

Overall Auto Trading Profit: <b>${USERS[userId].transaction_count ? Number(USERS[userId].total_profit).toFixed(2) : 0.0}</b> %`;
    saveUserList();
    ctx.replyWithPhoto(
      { source: thumbnailJPG },
      {
        caption: reportMessage,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Refresh", callback_data: "start_refresh" }],
            [
              {
                text: "💵 Token Balances",
                callback_data: "token_balances",
              },
              { text: "🔧 Auto Trade", callback_data: "setting" },
            ],
            [{ text: "👛 Wallet", callback_data: "wallet" }],
            [
              { text: "Buy", callback_data: "start_buy" },
              { text: "Sell/Manage", callback_data: "start_sell" },
            ],
          ],
        },
      },
    );
  } catch (error) {
    console.log(error);
  }
};

bot.start(async (ctx) => {
  await startBot(ctx);
});

async function getWalletMessage(userId) {
  const { address, balance } = await getBalanceNAddress(USERS[userId].wallet);
  const tokenBalances = await getAllTokenBalances(address);
  const displayTokens = tokenBalances.filter(
    (tk) =>
      USERS[userId].trading_tokens.indexOf(
        (tk1) =>
          tk1.baseToken.address.toLowerCase() == tk.address.toLowerCase(),
      ) == -1,
  );
  let nativeTokenInfo = await GetTokenInfo(nativeToken);
  nativeTokenInfo = nativeTokenInfo[0];
  let walletMessage = `Positions Overview`;
  let sum_usd = 0,
    sum_pls = 0,
    bi = 1;
  for (let i = 0; i < displayTokens.length; i++) {
    const tk = displayTokens[i];
    const tkinfo = await GetTokenInfo(tk.address);
    if (!tkinfo) continue;
    if (!USERS[userId].transactions) {
      USERS[userId].transactions = {
        buys: [],
        sells: [],
      };
    }
    const quotePLS = tkinfo.find(
      (t) => t.quoteToken.address.toLowerCase() === nativeToken.toLowerCase(),
    );
    const buys = USERS[userId].transactions.buys.filter(
      (buy) => buy.address === tk.address,
    );
    const sells = USERS[userId].transactions.sells.filter(
      (sell) => sell.address === tk.address,
    );
    const balance_usd = buys.reduce(
      (sum, buy) => sum + (Number(buy.usd) * buy.amount) / Number(buy.pls),
      0,
    );
    const balance_pls =
      buys.reduce((sum, buy) => sum + buy.amount, 0) -
      sells.reduce((sum, sell) => sum + sell.amount * Number(sell.pls), 0);
    const balance_amount =
      buys.reduce((sum, buy) => sum + buy.amount / Number(buy.pls), 0) -
      sells.reduce((sum, sell) => sum + sell.amount, 0);
    const profit_pls =
      ((quotePLS.priceNative * balance_amount - balance_pls) * 100) /
      balance_pls;
    walletMessage += `
<b>/${bi++} ${tk.symbol}</b>
Profit: <b>${Number(profit_pls).toFixed(2)}% / ${millify(Number(quotePLS.priceNative * balance_amount - balance_pls).toFixed(3))} PLS</b>
Value: <b>$ ${millify(Number(Number(quotePLS.priceUsd) * Number(tk.ui_value)).toFixed(3))} / ${millify(Number(Number(quotePLS.priceNative) * Number(tk.ui_value)).toFixed(3))} PLS</b>
Mcap: <b>$ ${millify(quotePLS.fdv)} @ $ ${millify(quotePLS.priceUsd)}</b>
`;
    sum_pls += Number(quotePLS.priceNative) * Number(tk.ui_value);
    sum_usd += Number(quotePLS.priceUsd) * Number(tk.ui_value);
  }

  walletMessage += `
Balance: <b>${millify(Number(balance).toFixed(3))} PLS</b>
Net Worth: <b>${millify(sum_pls.toFixed(3))} PLS / $ ${millify(sum_usd.toFixed(3))}</b>

`;
  return {
    message: walletMessage,
    options: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👈 Back", callback_data: "start_refresh" },
            { text: "🔄 Refresh", callback_data: "wallet" },
          ],
          [{ text: "🔃 Reset Wallet", callback_data: "reset_wallet" }],
          [
            {
              text: "👆 View on Pulsescan",
              url: `${pulseScanURL}/address/${address}`,
            },
          ],
          [
            {
              text: "💰 Withdraw all PLS",
              callback_data: "withdraw_all",
            },
            { text: "💰 Withdraw X PLS", callback_data: "withdraw_x" },
          ],
          [
            {
              text: "💷 Withdraw Kirk NFT",
              callback_data: "withdraw_kirk",
            },
          ],
          [{ text: "🔑 Export Private Key", callback_data: "export_pk" }],
        ],
      },
    },
  };
}

function getAutoBotSettingMessage(userId) {
  return {
    message: `<b>Kirk Bot settings</b>

You can set <b>Trade Amount</b>, <b>Selling Profit</b>, <b>Stop Loss</b>
<b>Minimum Liquidity Amount</b>, <b>Maximum Liquidity Amount</b>

And click Enable auto sniping if you want. It will buy and sell tokens when the price changes hit the profit and stoploss percentage.

Trade Amount: <b>${millify(USERS[userId].tradeAmount)}</b> PLS
Profit: <b>${USERS[userId].profit}</b> %
Stop loss: <b>-${USERS[userId].stopLoss}</b> %
Minimum Liquidity: $<b>${millify(USERS[userId].liquidityMinLimit)}</b>
Maximum Liquidity: $<b>${millify(USERS[userId].liquidityMaxLimit)}</b>
Liquidity Change in USD: $<b>${millify(USERS[userId].liquidityChange)}</b>

Please click the <b>button</b> if you want to change.
`,
    options: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚀 Enable auto sniping",
              callback_data: "enable_auto_sniping_query",
            },
            {
              text: "💰 Set trade amount",
              callback_data: "set_trade_amount",
            },
          ],
          [
            { text: "📉 Set profit %", callback_data: "set_profit" },
            {
              text: "📈 Set stop less %",
              callback_data: "set_stop_loss",
            },
          ],
          [
            {
              text: "Set LP min limit",
              callback_data: "set_min_liquidity_limit",
            },
            {
              text: "Set LP max limit",
              callback_data: "set_max_liquidity_limit",
            },
          ],
          [
            {
              text: "Set LP change in usd",
              callback_data: "set_liquidity_change_in_usd",
            },
          ],
          [{ text: "👈 Back", callback_data: "manage_back" }],
        ],
      },
    },
  };
}

async function showSellAndManageMenu(
  userId,
  telegram,
  chat_id,
  message_id,
  inline_message_id,
  direction,
) {
  const { address, balance } = await getBalanceNAddress(USERS[userId].wallet);
  const tokenBalances = await getAllTokenBalances(address);
  const displayTokens = tokenBalances.filter(
    (tk) =>
      USERS[userId].trading_tokens.indexOf(
        (tk1) =>
          tk1.baseToken.address.toLowerCase() == tk.address.toLowerCase(),
      ) == -1,
  );
  let nativeTokenInfo = await GetTokenInfo(nativeToken);
  nativeTokenInfo = nativeTokenInfo[0];
  let startSellMessage = `Positions Overview`;
  const tkinfos = [];
  for (const _token of displayTokens) {
    const tkinfo = await GetTokenInfo(_token.address);
    if (tkinfo) {
      tkinfos.push({
        tk: _token,
        tkinfo,
      });
    }
  }
  if (tkinfos.length > 0) {
    let cur_token = tkinfos.findIndex(
      (_token) => _token.tk.address === status[userId].coin_address,
    );
    if (direction === "next") {
      cur_token++;
    } else if (direction === "prev") {
      cur_token--;
    } else {
      cur_token = 0;
    }
    if (cur_token == -1) {
      cur_token = tkinfos.length - 1;
    }
    cur_token = cur_token % tkinfos.length;
    const tk = tkinfos[cur_token].tk;
    status[userId].coin_address = tk.address;
    const tkinfo = tkinfos[cur_token].tkinfo;
    if (!USERS[userId].transactions) {
      USERS[userId].transactions = {
        buys: [],
        sells: [],
      };
    }
    const quotePLS = tkinfo.find(
      (t) => t.quoteToken.address.toLowerCase() === nativeToken.toLowerCase(),
    );
    const buys = USERS[userId].transactions.buys.filter(
      (buy) => buy.address === tk.address,
    );
    const sells = USERS[userId].transactions.sells.filter(
      (sell) => sell.address === tk.address,
    );
    const balance_pls =
      buys.reduce((sum, buy) => sum + buy.amount, 0) -
      sells.reduce((sum, sell) => sum + sell.amount * Number(sell.pls), 0);
    const balance_amount =
      buys.reduce((sum, buy) => sum + buy.amount / Number(buy.pls), 0) -
      sells.reduce((sum, sell) => sum + sell.amount, 0);
    const profit_pls =
      ((quotePLS.priceNative * balance_amount - balance_pls) * 100) /
      balance_pls;
    startSellMessage += `
<b>${tk.symbol}</b>

Profit: <b>${profit_pls.toFixed(2)}% / ${millify((quotePLS.priceNative * balance_amount - balance_pls).toFixed(3))} PLS</b>
Value: <b>$ ${millify(Number(Number(quotePLS.priceUsd) * Number(tk.ui_value)).toFixed(3))} / ${millify(Number(Number(quotePLS.priceNative) * Number(tk.ui_value)).toFixed(3))} PLS </b>
Mcap: <b>$ ${millify(quotePLS.fdv)} @ $ ${millify(quotePLS.priceUsd)}</b>

Initial: <b>${millify(balance_pls)} PLS</b>
Balance: <b>${millify(Number(tk.ui_value))} ${tk.symbol}</b>
Wallet Balance: <b>${balance} PLS</b>

`;
    const options = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Home", callback_data: "start_refresh" },
            { text: "Close", callback_data: "manage_back" },
          ],
          [
            {
              text: "Buy 500k PLS",
              callback_data: "buy_500k_pls_" + tk.address,
            },
            { text: "Buy 1M PLS", callback_data: "buy_1m_pls_" + tk.address },
            { text: "Buy X PLS", callback_data: "buy_x_pls_" + tk.address },
          ],
          [
            { text: "◀ Prev", callback_data: "start_sell_prev_" + tk.address },
            { text: tk.symbol, callback_data: "start_sell_" + tk.symbol },
            { text: "Next ▶", callback_data: "start_sell_next_" + tk.address },
          ],
          [
            {
              text: "Sell 50%",
              callback_data: "sell_50_percent_" + tk.address,
            },
            {
              text: "Sell 100%",
              callback_data: "sell_100_percent_" + tk.address,
            },
            { text: "Sell X %", callback_data: "sell_x_percent_" + tk.address },
          ],
          [{ text: "🔄 Refresh", callback_data: "start_sell_" + tk.address }],
        ],
      },
    };
    try {
      if (message_id) {
        await telegram.editMessageCaption(
          chat_id,
          message_id,
          inline_message_id,
          startSellMessage,
          options,
        );
      } else {
        await telegram.sendMessage(chat_id, startSellMessage, options);
      }
    } catch (e) {
      console.log(e);
    }
  }
}

bot.on("callback_query", async (data) => {
  const userId = data.update.callback_query.from.id;
  const username = data.update.callback_query.from.username;
  if (!status[userId]) {
    status[userId] = {
      withdrawing: false,
      withdraw_message_id: -1,
      isWithdrawAll: false,
      amount_message_id: -1,
      coin_address_message_id: -1,
      buying: false,
      withdraw_address: "",
      coin_address: "",
      selling: false,
      trade_amount_message_id: -1,
      stop_loss_message_id: -1,
      profit_message_id: -1,
      liquidity_min_message_id: -1,
      liquidity_max_message_id: -1,
      liquidity_change_message_id: -1,
    };
  }
  status[userId].withdrawing = false;
  status[userId].selling = false;
  status[userId].buying = false;

  const kirkBalance = await GetKirtNFTBalance(USERS[userId].wallet);
  USERS[userId].hasNFT = kirkBalance.length > 0;
  saveUserList();

  const { address, balance } = await getBalanceNAddress(USERS[userId].wallet);
  const withdrawBalanceMsg = `Enter Pulse Wallet address where you want to withdraw the amount`;
  switch (data.update.callback_query.data) {
    case "start_refresh":
      let startMsg = `
Welcome to KirkBot, Pulsechain’s fastest and most reliable sniper bot.
  
Your current <b>PLS</b> balance is <b>${millify(Number(balance).toFixed(3))}</b> ($${millify((Number(balance) * (await GetPulseUSDPrice())).toFixed(3))})
To add to your balance you can send some <b>PLS</b> to your pulse wallet address:
<code>${address}</code>(Tap on the address to Copy)

${
  kirkBalance.length
    ? `You have  <b>Kirk NFT #${kirkBalance.join(", #")}</b>
You can snipe from now
`
    : `You don't have any <b>Kirk NFTs</b>. Please purchase it at least one if you want to use this bot.`
}

Overall Auto Trading Profit: <b>${USERS[userId].transaction_count ? (USERS[userId].total_profit / USERS[userId].transaction_count).toFixed(2) : 0.0}</b> %`;

      try {
        await data.telegram.editMessageCaption(
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
          data.update.callback_query.inline_message_id,
          startMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "start_refresh" }],
                [
                  {
                    text: "💵 Token Balances",
                    callback_data: "token_balances",
                  },
                  { text: "🔧 Auto Trade", callback_data: "setting" },
                ],
                [{ text: "👛 Wallet", callback_data: "wallet" }],
                [
                  { text: "Buy", callback_data: "start_buy" },
                  { text: "Sell/Manage", callback_data: "start_sell" },
                ],
              ],
            },
          },
        );
      } catch (e) {
        console.log("Nothing updated", e);
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "wallet":
      let walletMessage = await getWalletMessage(userId);

      try {
        await data.telegram.editMessageCaption(
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
          data.update.callback_query.inline_message_id,
          walletMessage.message,
          walletMessage.options,
        );
      } catch (e) {
        console.log("Nothing updated", e);
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "withdraw_all":
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          withdrawBalanceMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter wallet address",
            },
          },
        );
        status[userId].withdraw_message_id = res.message_id;
        status[userId].withdrawing = true;
        status[userId].isWithdrawAll = true;
      } catch (e) {
        console.log("Nothing updated");
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "withdraw_x":
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          withdrawBalanceMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter wallet address",
            },
          },
        );
        status[userId].withdraw_message_id = res.message_id;
        status[userId].withdrawing = true;
        status[userId].isWithdrawAll = false;
      } catch (e) {
        console.log("Nothing updated");
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "withdraw_kirk":
      try {
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          `Are you sure to withdraw your Kirk <b>#${kirkBalance[0]}</b>?

If you don't have Kirk, you can't trade with this bot.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              inline_keyboard: [
                [
                  {
                    text: "Yes",
                    callback_data: "yes_withdraw_kirk",
                  },
                  {
                    text: "No",
                    callback_data: "no_withdraw_kirk",
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        console.log;
      }
      break;
    case "token_balances":
      try {
        const tokenBalances = await getAllTokenBalances(address);
        for (const tk of USERS[userId].trading_tokens) {
          if (
            tokenBalances.findIndex(
              (tb) => tb.address === tk.baseToken.address,
            ) > -1
          )
            continue;
          const name = await getTokenName(tk.baseToken.address);
          const symbol = await getTokenSymbol(tk.baseToken.address);
          const balance = await getTokenBalance(tk.baseToken.address, address);
          tokenBalances.push({
            address: tk.baseToken.address,
            name,
            symbol,
            ui_value: balance,
          });
        }
        let token_balancesMsg = `You have no tokens`;
        if (tokenBalances.length)
          token_balancesMsg = `Your <b>Token Balances</b> are
`;
        for (const _token of tokenBalances) {
          const tkinfo = await GetTokenInfo(_token.address);
          if (!tkinfo) continue;
          if (!USERS[userId].transactions) {
            USERS[userId].transactions = {
              buys: [],
              sells: [],
            };
          }
          const quotePLS = tkinfo.find(
            (t) =>
              t.quoteToken.address.toLowerCase() === nativeToken.toLowerCase(),
          );
          const buys = USERS[userId].transactions.buys.filter(
            (buy) => buy.address === _token.address,
          );
          const buyinfo = buys
            .map(
              (buy) =>
                `${millify(Number(buy.pls * buy.amount).toFixed(3))} ($${millify(Number(buy.usd * buy.amount).toFixed(3))})`,
            )
            .join(", ");
          const sells = USERS[userId].transactions.sells.filter(
            (sell) => sell.address === _token.address,
          );
          const sellinfo = sells
            .map(
              (sell) =>
                `${millify(Number(sell.pls * sell.amount).toFixed(3))} ($${millify(Number(sell.usd * sell.amount).toFixed(3))})`,
            )
            .join(", ");
          const balance_usd = buys.reduce(
            (sum, buy) =>
              sum + (Number(buy.usd) * buy.amount) / Number(buy.pls),
            0,
          );
          const balance_pls =
            buys.reduce((sum, buy) => sum + buy.amount, 0) -
            sells.reduce((sum, sell) => sum + sell.amount, 0);
          const balance_amount =
            buys.reduce((sum, buy) => sum + buy.amount / Number(buy.pls), 0) -
            sells.reduce(
              (sum, sell) => sum + sell.amount / Number(sell.pls),
              0,
            );
          console.log(balance_usd, balance_pls, balance_amount);
          const profit_usd =
            ((quotePLS.priceUsd * balance_amount - balance_usd) * 100) /
            balance_usd;
          const profit_pls =
            ((quotePLS.priceNative * balance_amount - balance_pls) * 100) /
            balance_pls;
          token_balancesMsg += `
${_token.name} : <b>${millify(Number(_token.ui_value).toFixed(3))} ($${millify(Number(Number(_token.ui_value) * quotePLS.priceUsd).toFixed(3))})</b> ${_token.symbol} - <code>${_token.address}</code>

▫ Price & MC: $${quotePLS.priceUsd} - $${quotePLS.fdv}
▫ Balance: ${millify(Number(_token.ui_value).toFixed(3))}
▫ Buys: ${buyinfo ? `${buys.length} Buys  ` + buyinfo : "N/A"}
▫ Sells: ${sellinfo ? `${sells.length} Sells  ` + sellinfo : "N/A"}
▫ PNL USD: ${Number(profit_usd).toFixed(3)}% ($ ${quotePLS.priceUsd * balance_amount - balance_usd})
▫ PNL PLS: ${Number(profit_pls).toFixed(3)}% (${quotePLS.priceNative * balance_amount - balance_pls} PLS)
`;
        }
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          token_balancesMsg,
          {
            parse_mode: "HTML",
          },
        );
      } catch (e) {
        console.log(e);
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "start_buy":
      let startBuyMessage = `Enter the coin address you want to buy`;
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          startBuyMessage,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter coin address",
            },
          },
        );
        console.log(res);
        status[userId].coin_address_message_id = res.message_id;
        status[userId].buying = true;
      } catch (e) {
        console.log("Nothing updated");
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "start_sell":
      await data.telegram.answerCbQuery(data.update.callback_query.id);
      await showSellAndManageMenu(
        userId,
        data.telegram,
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
        data.update.callback_query.inline_message_id,
      );
      break;
    case "manage_back":
      data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      break;
    case "enable_auto_sniping_query":
      try {
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          `Are you sure to enable auto sniping?

All your transactions will be created by bot and controlled by <b>profit</b> and <b>stop loss</b> percentage.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              inline_keyboard: [
                [
                  {
                    text: "Yes",
                    callback_data: "enable_auto_sniping",
                  },
                  {
                    text: "No",
                    callback_data: "disable_auto_sniping",
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        console.log;
      }
      break;
    case "setting":
      let settingMessage = getAutoBotSettingMessage(userId);
      await data.telegram.editMessageCaption(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
        data.update.callback_query.inline_message_id,
        settingMessage.message,
        settingMessage.options,
      );
      break;
    case "set_profit":
      let profitValueMsg = `When the token price exceeds <b>Profit</b> percentage, the bot sells the tokens. 
      
Enter the profit percentage. <b>(0, ~)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          profitValueMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter the profit percentage",
            },
          },
        );
        status[userId].profit_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "set_trade_amount":
      let tradeAmountMsg = `The <b>PLS</b> you will spend when buy tokens. (per transaction) 
      
Enter trade amount. <b>(0,100000000000)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          tradeAmountMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter trade amount",
            },
          },
        );
        status[userId].trade_amount_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "set_stop_loss":
      let stopLossMsg = `When token's price is falling, if the loss percent falls than <b>Stop Loss</b> percentage, bot sells the token. 
      
Enter stoploss percentage. <b>(0,100)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          stopLossMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter stoploss",
            },
          },
        );
        console.log(res);
        status[userId].stop_loss_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "reset_wallet":
      let resetWalletMsg = `
Your previous wallet information will be disappeared permanently

Are you really reset your wallet?`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          resetWalletMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter trade amount",
              inline_keyboard: [
                [
                  {
                    text: "Yes",
                    callback_data: "reset_yes",
                  },
                  {
                    text: "No",
                    callback_data: "reset_no",
                  },
                ],
              ],
            },
          },
        );
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "reset_yes":
      try {
        const addressData = Wallet.generate();
        const newPK = addressData.getPrivateKeyString();
        const newADS = addressData.getAddressString();

        USERS[userId].wallet = newPK;
        saveUserList();
        const wallet_reset_Msg = `Successfully Reset!

Your new wallet address is <code>${newADS}</code>`;
        await data.telegram.deleteMessage(
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
        );
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          wallet_reset_Msg,
          {
            parse_mode: "HTML",
          },
        );
      } catch (e) {
        console.log("Nothing updated", e);
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "reset_no":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      break;
    case "export_pk":
      const exportWalletMsg = `Are you sure you want to export your <b>Private Key</b>?`;
      const res = await data.telegram.sendMessage(
        data.update.callback_query.message.chat.id,
        exportWalletMsg,
        {
          parse_mode: "HTML",
          reply_markup: {
            force_reply: true,
            inline_keyboard: [
              [
                {
                  text: "Cancel",
                  callback_data: "export_cancel",
                },
                {
                  text: "Confirm",
                  callback_data: "export_confirm",
                },
              ],
            ],
          },
        },
      );
      break;
    case "export_cancel":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      break;
    case "export_confirm":
      const exportPkMsg = `Your <b>Private Key</b> is:

<code>${USERS[userId].wallet}</code>
      
You can now i.e. import the key into a wallet like <b>MetaMask</b>. (tap to copy).
Delete this message once you are done.`;
      await data.telegram.editMessageText(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
        data.update.callback_query.inline_message_id,
        exportPkMsg,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Delete", callback_data: "delete_pk" }]],
          },
        },
      );
      break;
    case "delete_pk":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      break;
    case "set_min_liquidity_limit":
      let liquidityMinMsg = `Your bot will filter the tokens that has liquidity as much as minimum amount to snipe.
      
Enter minimum liquidity amount. <b>(0,1000000000)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          liquidityMinMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter minimum liquidity amount",
            },
          },
        );
        console.log(res);
        status[userId].liquidity_min_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "set_max_liquidity_limit":
      let liquidityMaxMsg = `Your bot will filter the tokens that has liquidity as much as maximum amount to snipe.
      
Enter maximum liquidity amount. <b>(0,1000000000)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          liquidityMaxMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter maximum liquidity amount",
            },
          },
        );
        console.log(res);
        status[userId].liquidity_max_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    case "enable_auto_sniping":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      if (USERS[userId].bot_running) {
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          "Auto sniping is already enabled.",
          { parse_mode: "HTML" },
        );
        await data.telegram.answerCbQuery(data.update.callback_query.id);
        break;
      }
      USERS[userId].bot_running = true;
      saveUserList();
      await data.telegram.sendMessage(
        data.update.callback_query.message.chat.id,
        "Auto sniping is enabled.",
        {
          parse_mode: "HTML",
        },
      );
      await data.telegram.answerCbQuery(data.update.callback_query.id);
      break;
    case "disable_auto_sniping":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      if (!USERS[userId].bot_running) {
        await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          "Auto sniping is already disabled.",
          { parse_mode: "HTML" },
        );
        await data.telegram.answerCbQuery(data.update.callback_query.id);
        break;
      }
      USERS[userId].bot_running = false;
      saveUserList();
      await data.telegram.sendMessage(
        data.update.callback_query.message.chat.id,
        "Auto sniping is disabled.",
        {
          parse_mode: "HTML",
        },
      );
      await data.telegram.answerCbQuery(data.update.callback_query.id);
      break;
    case "yes_withdraw_kirk":
      await data.telegram.deleteMessage(
        data.update.callback_query.message.chat.id,
        data.update.callback_query.message.message_id,
      );
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          `Please enter withdrawal Address for Kirk.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter wallet address",
            },
          },
        );
        status[userId].withdraw_kirk_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
        await data.telegram.answerCbQuery(data.update.callback_query.id);
      }
      break;
    case "sell_25_percent":
      await sellToken(
        data,
        data.update.callback_query.message.chat.id,
        userId,
        status[userId].coin_address,
        address,
        USERS[userId].wallet,
        25,
      );
      break;
    case "sell_50_percent":
      await sellToken(
        data,
        data.update.callback_query.message.chat.id,
        userId,
        status[userId].coin_address,
        address,
        USERS[userId].wallet,
        50,
      );
      break;
    case "sell_100_percent":
      await sellToken(
        data,
        data.update.callback_query.message.chat.id,
        userId,
        status[userId].coin_address,
        address,
        USERS[userId].wallet,
        100,
      );
      break;
    case "sell_x_percent":
      try {
        status[userId].selling = true;
        const token_symbol = await getTokenSymbol(status[userId].coin_address);
        const token_balance = await getTokenBalance(
          status[userId].coin_address,
          address,
        );
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          `Balance is ${Number(token_balance).toFixed(3)} ${token_symbol}. Enter the percentage of ${token_symbol}.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter the percentage",
            },
          },
        );
        status[userId].amount_message_id = res.message_id;
      } catch (e) {
        console.log(e);
      }
      break;
    case "set_liquidity_change_in_usd":
      let liquidityChangeMsg = `Your bot will filter the tokens when change of liquidity is above this value
      
Enter change of liquidity amount in usd. <b>(0,1000000000)</b>`;

      await data.telegram.answerCbQuery(data.update.callback_query.id);
      try {
        const res = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          liquidityChangeMsg,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter change of liquidity amount",
            },
          },
        );
        console.log(res);
        status[userId].liquidity_change_message_id = res.message_id;
      } catch (e) {
        console.log("Nothing updated");
      }
      break;
    default:
      if (data.update.callback_query.data.indexOf("sell_token_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "sell_token_",
          "",
        );
        status[userId].coin_address = token_address;
        const symbol = await getTokenSymbol(token_address);

        await data.telegram.editMessageCaption(
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
          data.update.callback_query.inline_message_id,
          "",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `✅ ${symbol}`,
                    callback_data: data.update.callback_query.data,
                  },
                ],
                [
                  { text: `Sell 25%`, callback_data: "sell_25_percent" },
                  { text: `Sell 50%`, callback_data: "sell_50_percent" },
                  { text: `Sell 100%`, callback_data: "sell_100_percent" },
                  { text: `Sell X% ✏`, callback_data: "sell_x_percent" },
                ],
                [
                  { text: "👈 Back", callback_data: "start_refresh" },
                  {
                    text: "🔄 Refresh",
                    callback_data: data.update.callback_query.data,
                  },
                ],
              ],
            },
          },
        );
        // status[userId].coin_address_message_id = res.message_id;
        // status[userId].selling = true;
      }

      if (data.update.callback_query.data.indexOf("start_sell_prev_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "start_sell_prev_",
          "",
        );
        status[userId].coin_address = token_address;
        await showSellAndManageMenu(
          userId,
          data.telegram,
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
          data.update.callback_query.inline_message_id,
          "prev",
        );
      }
      if (data.update.callback_query.data.indexOf("start_sell_next_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "start_sell_next_",
          "",
        );
        status[userId].coin_address = token_address;
        await showSellAndManageMenu(
          userId,
          data.telegram,
          data.update.callback_query.message.chat.id,
          data.update.callback_query.message.message_id,
          data.update.callback_query.inline_message_id,
          "next",
        );
      }
      if (data.update.callback_query.data.indexOf("buy_500k_pls_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "buy_500k_pls_",
          "",
        );
        status[userId].coin_address = token_address;
        await buyToken(
          userId,
          data.telegram,
          data.update.callback_query.message.chat.id,
          status[userId].coin_address,
          500000,
        );
      }
      if (data.update.callback_query.data.indexOf("buy_1m_pls_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "buy_1m_pls_",
          "",
        );
        status[userId].coin_address = token_address;
        await buyToken(
          userId,
          data.telegram,
          data.update.callback_query.message.chat.id,
          status[userId].coin_address,
          1000000,
        );
      }
      if (data.update.callback_query.data.indexOf("buy_x_pls_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "buy_x_pls_",
          "",
        );
        status[userId].coin_address = token_address;
        const token_symbol = await getTokenSymbol(status[userId].coin_address);
        const buy_amount_message = await data.telegram.sendMessage(
          data.update.callback_query.message.chat.id,
          `Enter the amount of PLS that you want to use for purchase ${token_symbol}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter the amount",
            },
          },
        );
        status[userId].buying = true;
        status[userId].amount_message_id = buy_amount_message.message_id;
      }
      if (data.update.callback_query.data.indexOf("sell_50_percent_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "sell_50_percent_",
          "",
        );
        status[userId].coin_address = token_address;
        await sellToken(
          data,
          data.update.callback_query.message.chat.id,
          userId,
          status[userId].coin_address,
          address,
          USERS[userId].wallet,
          50,
        );
      }
      if (data.update.callback_query.data.indexOf("sell_100_percent_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "sell_100_percent_",
          "",
        );
        status[userId].coin_address = token_address;
        await sellToken(
          data,
          data.update.callback_query.message.chat.id,
          userId,
          status[userId].coin_address,
          address,
          USERS[userId].wallet,
          100,
        );
      }
      if (data.update.callback_query.data.indexOf("sell_x_percent_") > -1) {
        let token_address = data.update.callback_query.data.replace(
          "sell_x_percent_",
          "",
        );
        status[userId].coin_address = token_address;
        try {
          status[userId].selling = true;
          const token_symbol = await getTokenSymbol(
            status[userId].coin_address,
          );
          const token_balance = await getTokenBalance(
            status[userId].coin_address,
            address,
          );
          const res = await data.telegram.sendMessage(
            data.update.callback_query.message.chat.id,
            `Balance is ${Number(token_balance).toFixed(3)} ${token_symbol}. Enter the percentage of ${token_symbol}.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                force_reply: true,
                input_field_placeholder: "Enter the percentage",
              },
            },
          );
          status[userId].amount_message_id = res.message_id;
        } catch (e) {
          console.log(e);
        }
      }
      break;
  }
});

async function withdrawalProcess(ctx, userId, amount) {
  const waitingMsg = await ctx.telegram.sendMessage(
    ctx.message.chat.id,
    `Withdrawal in progress...`,
    {
      parse_mode: "HTML",
    },
  );
  const res = await withdrawPulse(
    USERS[userId].wallet,
    status[userId].withdraw_address,
    amount,
  );
  const after_pls = await getBalanceNAddress(USERS[userId].wallet);
  if (!res) {
    await ctx.telegram.editMessageText(
      ctx.message.chat.id,
      waitingMsg.message_id,
      undefined,
      `Failed Withdrawn`,
    );
    status[userId].withdrawing = false;
    status[userId].withdraw_message_id = -1;
    return;
  }
  await ctx.telegram.editMessageText(
    ctx.message.chat.id,
    waitingMsg.message_id,
    undefined,
    `Your PLS withdrawn successfully.
${pulseScanURL}/tx/${res}
Your balance is <b>${millify(Number(after_pls.balance).toFixed(3))}</b> PLS`,
    {
      parse_mode: "HTML",
    },
  );
  status[userId].withdrawing = false;
  status[userId].withdraw_message_id = -1;
}

async function sellToken(
  ctx,
  chat_id,
  userId,
  token_address,
  user_address,
  pk,
  percentage,
) {
  const tkinfo = await GetTokenInfo(token_address);

  const quotePLS = tkinfo.find(
    (tk) => tk.quoteToken.address.toLowerCase() === nativeToken.toLowerCase(),
  );
  const amount =
    ((await getTokenBalance(token_address, user_address)) * percentage) / 100;
  const { address, balance } = await getBalanceNAddress(pk);
  const waitingMsg = await ctx.telegram.sendMessage(
    chat_id,
    `Selling in progress...`,
    { parse_mode: "HTML" },
  );
  const res = await swapPulse(
    pulseProvider,
    pk,
    process.env.PULSEROUTER,
    token_address,
    nativeToken,
    amount,
  );
  if (res.status) {
    const res1 = await getBalanceNAddress(pk);
    const token_symbol = await getTokenSymbol(token_address);
    const after_token_balance = await getTokenBalance(token_address, address);
    await ctx.telegram.editMessageText(
      chat_id,
      waitingMsg.message_id,
      undefined,
      `
  Swap Successful:
Sold <b>${millify(Number(amount).toFixed(3))}</b> <b>${token_symbol}</b> for <b>${millify(
        Number(balance) - Number(res1.balance).toFixed(3),
      )}</b> PLS
  ${pulseScanURL}/tx/${res.tx}

  Your <b>PLS</b> balance is <b>${millify(Number(res1.balance).toFixed(3))}</b> .
  Your <b>${token_symbol}</b> balance is <b>${millify(Number(after_token_balance).toFixed(3))}</b>`,
      {
        parse_mode: "HTML",
      },
    );
    if (!USERS[userId].transactions) {
      USERS[userId].transactions = {
        buys: [],
        sells: [],
      };
    }
    USERS[userId].transactions.sells.push({
      address: token_address,
      usd: quotePLS.priceUsd,
      pls: quotePLS.priceNative,
      amount,
    });
    saveUserList();
  } else {
    await ctx.telegram.editMessageText(
      chat_id,
      waitingMsg.message_id,
      undefined,
      `You don't have enough balance to sell. Your balance is <b>${millify(Number(balance).toFixed(3))}</b> PLS`,
      {
        parse_mode: "HTML",
      },
    );
  }
}

async function buyToken(userId, telegram, chat_id, coin_address, amount) {
  const { address, balance } = await getBalanceNAddress(USERS[userId].wallet);
  const waitingMsg = await telegram.sendMessage(
    chat_id,
    `Buying in progress...`,
    {
      parse_mode: "HTML",
    },
  );
  const pre_token_balance = await getTokenBalance(coin_address, address);
  const res = await swapPulse(
    pulseProvider,
    USERS[userId].wallet,
    process.env.PULSEROUTER,
    nativeToken,
    coin_address,
    amount,
  );
  if (res.status) {
    const res1 = await getBalanceNAddress(USERS[userId].wallet);
    const token_symbol = await getTokenSymbol(coin_address);
    const after_token_balance = await getTokenBalance(coin_address, address);
    await telegram.editMessageText(
      chat_id,
      waitingMsg.message_id,
      undefined,
      `
Swap Successful:
Bought <b>${millify(
        Number(after_token_balance - pre_token_balance).toFixed(3),
      )}</b> <b>${token_symbol}</b> for <b>${amount}</b> PLS
${pulseScanURL}/tx/${res.tx}

Your <b>PLS</b> balance is <b>${millify(Number(res1.balance).toFixed(3))}</b> .
Your <b>${token_symbol}</b> balance is <b>${millify(Number(after_token_balance).toFixed(3))}</b>`,
      {
        parse_mode: "HTML",
      },
    );
    const tkinfo = await GetTokenInfo(coin_address);

    const quotePLS = tkinfo.find(
      (tk) => tk.quoteToken.address.toLowerCase() === nativeToken.toLowerCase(),
    );

    if (!USERS[userId].transactions) {
      USERS[userId].transactions = {
        buys: [],
        sells: [],
      };
    }
    USERS[userId].transactions.buys.push({
      address: coin_address,
      pls: quotePLS.priceNative,
      usd: quotePLS.priceUsd,
      amount: amount,
    });
    saveUserList();
  } else {
    await telegram.editMessageText(
      chat_id,
      waitingMsg.message_id,
      undefined,
      `You don't have enough balance to buy. Your balance is <b>${millify(Number(balance).toFixed(3))}</b> PLS`,
      {
        parse_mode: "HTML",
      },
    );
  }
}

bot.command("home", async (ctx) => {
  await startBot(ctx);
});

bot.command("wallet", async (ctx) => {
  const userId = ctx.from.id;
  initStatus(userId);
  let walletMessage = await getWalletMessage(userId);

  try {
    await ctx.telegram.sendMessage(
      ctx.message.chat.id,
      walletMessage.message,
      walletMessage.options,
    );
  } catch (e) {
    console.log("Nothing updated", e);
  }
});

bot.command("auto", async (ctx) => {
  const userId = ctx.from.id;
  initStatus(userId);
  let settingMessage = getAutoBotSettingMessage(userId);
  await ctx.telegram.sendMessage(
    ctx.message.chat.id,
    settingMessage.message,
    settingMessage.options,
  );
});

bot.command("buy", async (ctx) => {
  const userId = ctx.from.id;
  initStatus(userId);
  let startBuyMessage = `Enter the coin address you want to buy`;
  try {
    const res = await ctx.telegram.sendMessage(
      ctx.message.chat.id,
      startBuyMessage,
      {
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Enter coin address",
        },
      },
    );
    console.log(res);
    status[userId].coin_address_message_id = res.message_id;
    status[userId].buying = true;
  } catch (e) {
    console.log("Nothing updated");
  }
});

bot.command("sell", async (ctx) => {
  const userId = ctx.from.id;
  initStatus(userId);
  await showSellAndManageMenu(userId, ctx.telegram, ctx.message.chat.id);
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  let address,
    balance = 0;

  if (!status[userId]) {
    status[userId] = {
      withdrawing: false,
      withdraw_message_id: -1,
      isWithdrawAll: false,
      amount_message_id: -1,
      coin_address_message_id: -1,
      buying: false,
      withdraw_address: "",
      coin_address: "",
      selling: false,
      trade_amount_message_id: -1,
      stop_loss_message_id: -1,
      profit_message_id: -1,
      liquidity_min_message_id: -1,
      liquidity_max_message_id: -1,
      liquidity_change_message_id: -1,
    };
  }

  if (!USERS[userId]) {
    const addressData = Wallet.generate();
    const newPK = addressData.getPrivateKeyString();
    const newADS = addressData.getAddressString();

    USERS[userId] = {
      chat_id: ctx.message.chat.id,
      wallet: newPK,
      profit: Number(process.env.PROFIT),
      tradeAmount: Number(process.env.TRADE_AMOUNT),
      stopLoss: Number(process.env.STOP_LOSS ?? 10),
      liquidityMinLimit: Number(process.env.LIQUIDITY_MIN_LIMIT) ?? 500,
      liquidityMaxLimit: Number(process.env.LIQUIDITY_MAX_LIMIT) ?? 0,
      liquidityChange: 0,
      hasNFT: false,
      bot_running: true,
      total_profit: 0,
      transaction_count: 0,
      trading_tokens: [],
      transactions: {
        buys: [],
        sells: [],
      },
    };
    address = newADS;
    balance = 0;
  } else {
    const { address: _address, balance: _balance } = await getBalanceNAddress(
      USERS[userId].wallet,
    );
    const kirkBalance = await GetKirtNFTBalance(USERS[userId].wallet);
    USERS[userId].hasNFT = kirkBalance.length > 0;
    saveUserList();
    address = _address;
    balance = Number(_balance);
  }

  if (status[userId].withdrawing && ctx.message.reply_to_message) {
    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].withdraw_message_id
    ) {
      // withdraw
      try {
        status[userId].withdraw_address = ctx.message.text;
        if (status[userId].isWithdrawAll) {
          const { balance: _balance } = await getBalanceNAddress(
            USERS[userId].wallet,
          );
          await withdrawalProcess(ctx, userId, Number(_balance) - 20);
        } else {
          const res = await ctx.telegram.sendMessage(
            ctx.message.chat.id,
            "Enter the amount you want to withdraw to wallet",
            {
              parse_mode: "HTML",
              reply_markup: {
                force_reply: true,
                input_field_placeholder: "Enter the amount to transfer",
              },
            },
          );
          status[userId].amount_message_id = res.message_id;
        }
      } catch (e) {
        console.log(e);
      }
    }

    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].amount_message_id
    ) {
      const amount = Number(ctx.message.text);
      if (balance < amount + 20) {
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          `You don't have enough balance to withdraw. Your balance is <b>${millify(balance.toFixed(3))}</b> PLS`,
          { parse_mode: "HTML" },
        );
        status[userId].withdrawing = false;
        status[userId].isWithdrawAll = false;
        status[userId].withdraw_message_id = -1;
        return;
      }
      await withdrawalProcess(ctx, userId, amount);
    }
  } else if (status[userId].buying && ctx.message.reply_to_message) {
    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].coin_address_message_id
    ) {
      try {
        status[userId].coin_address = ctx.message.text;
        const token_symbol = await getTokenSymbol(status[userId].coin_address);
        const res = await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          `Enter the amount of PLS that you want to use for purchase ${token_symbol}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter the amount",
            },
          },
        );
        status[userId].amount_message_id = res.message_id;
      } catch (e) {
        console.log(e);
      }
    }
    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].amount_message_id
    ) {
      if (1 === 0) {
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          `You don't have any <b>Kirk NFT</b>. Can't trade!`,
          {
            parse_mode: "HTML",
          },
        );
      } else {
        const amount = Number(ctx.message.text);
        await buyToken(
          userId,
          ctx.telegram,
          ctx.message.chat.id,
          status[userId].coin_address,
          amount,
        );
      }

      status[userId].buying = false;
      status[userId].coin_address_message_id = -1;
      status[userId].amount_message_id = -1;
    }
  } else if (status[userId].selling && ctx.message.reply_to_message) {
    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].coin_address_message_id
    ) {
      try {
        status[userId].coin_address = ctx.message.text;
        const token_symbol = await getTokenSymbol(status[userId].coin_address);
        const token_balance = await getTokenBalance(
          status[userId].coin_address,
          address,
        );
        const res = await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          `Balance is ${millify(
            Number(token_balance).toFixed(3),
          )} ${token_symbol}. Enter the amount of ${token_symbol}.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              force_reply: true,
              input_field_placeholder: "Enter the amount",
            },
          },
        );
        status[userId].amount_message_id = res.message_id;
      } catch (e) {
        console.log(e);
      }
    }
    if (
      ctx.message.reply_to_message.message_id ==
      status[userId].amount_message_id
    ) {
      const kirkBalance = await GetKirtNFTBalance(USERS[userId].wallet);
      if (1 === 0) {
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          `You don't have any <b>Kirk NFT</b>. Can't trade!`,
          {
            parse_mode: "HTML",
          },
        );
      } else {
        await sellToken(
          ctx,
          ctx.message.chat.id,
          userId,
          status[userId].coin_address,
          address,
          USERS[userId].wallet,
          Number(ctx.message.text),
        );
      }
      status[userId].selling = false;
      status[userId].coin_address_message_id = -1;
      status[userId].amount_message_id = -1;
    }
  } else if (ctx.message.reply_to_message) {
    switch (ctx.message.reply_to_message.message_id) {
      case status[userId].trade_amount_message_id:
        let tradeSettingMessage = `Your trade amount was set <b>${ctx.message.text} PLS per transaction</b>`;
        if (
          Number(ctx.message.text) > 0 &&
          Number(ctx.message.text) < 100000000000
        )
          USERS[userId].tradeAmount = Number(ctx.message.text);
        else
          tradeSettingMessage = `The trade amount should be numbers between 0 and 100000000000`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          tradeSettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].stop_loss_message_id:
        let stopLossSettingMessage = `Your stop loss was set <b>-${ctx.message.text}</b> %`;
        if (Number(ctx.message.text) > 0 && Number(ctx.message.text) < 100)
          USERS[userId].stopLoss = Number(ctx.message.text);
        else
          stopLossSettingMessage = `The stop loss should be numbers between 0 and 100`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          stopLossSettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].profit_message_id:
        let profitSettingMessage = `Your profit percent was set <b>${millify(ctx.message.text)}</b> %`;
        if (Number(ctx.message.text) > 0)
          USERS[userId].profit = Number(ctx.message.text);
        else
          profitSettingMessage = `The profit should be numbers between 0 and 100`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          profitSettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].liquidity_change_message_id:
        let changeLiquiditySettingMessage = `Your change of liquidity was set <b>$${millify(ctx.message.text)}</b>`;
        if (
          Number(ctx.message.text) > 0 &&
          Number(ctx.message.text) < 100000000000
        )
          USERS[userId].liquidityChange = Number(ctx.message.text);
        else
          changeLiquiditySettingMessage = `The change of liquidity should be numbers between 0 and ${millify(100000000000)}`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          changeLiquiditySettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].liquidity_min_message_id:
        let minLiquiditySettingMessage = `Your minimum liquidity was set <b>$${millify(ctx.message.text)}</b>`;
        if (
          Number(ctx.message.text) > 0 &&
          Number(ctx.message.text) < 100000000000
        )
          USERS[userId].liquidityMinLimit = Number(ctx.message.text);
        else
          minLiquiditySettingMessage = `The min liquidity should be numbers between 0 and ${millify(100000000000)}`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          minLiquiditySettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].liquidity_max_message_id:
        let maxLiquiditySettingMessage = `Your maximum liquidity was set <b>$${millify(ctx.message.text)}</b>`;
        if (
          Number(ctx.message.text) > 0 &&
          Number(ctx.message.text) < 100000000000
        )
          USERS[userId].liquidityMaxLimit = Number(ctx.message.text);
        else
          maxLiquiditySettingMessage = `The max liquidity should be numbers between 0 and ${millify(100000000000)}`;
        await ctx.telegram.sendMessage(
          ctx.message.chat.id,
          maxLiquiditySettingMessage,
          { parse_mode: "HTML" },
        );
        break;
      case status[userId].withdraw_kirk_message_id:
        let withdrawKirkMsg = `Please input valid address for withdrawn.`;
        if (ctx.message.text.length === 42) {
          const waitingMsg = await ctx.telegram.sendMessage(
            ctx.message.chat.id,
            `Withdrawal Kirk in progress...`,
            {
              parse_mode: "HTML",
            },
          );
          const txHashs = await withdrawKirk(
            USERS[userId].wallet,
            ctx.message.text,
          );
          USERS[userId].hasNFT = false;
          saveUserList();
          withdrawKirkMsg = `${
            txHashs.length
              ? `Successfully withrawn your <b>Kirk</b>.

${txHashs.map((_tx) => `${pulseScanURL}/tx/${_tx}`).join("\n \n")}`
              : "Failed to withdraw"
          }`;

          await ctx.telegram.editMessageText(
            ctx.message.chat.id,
            waitingMsg.message_id,
            undefined,
            withdrawKirkMsg,
            {
              parse_mode: "HTML",
            },
          );
          USERS[userId].withdraw_kirk_message_id = -1;
          break;
        }
        await ctx.telegram.sendMessage(ctx.message.chat.id, withdrawKirkMsg, {
          parse_mode: "HTML",
        });
        USERS[userId].withdraw_kirk_message_id = -1;

        break;
      default:
        break;
    }
    saveUserList();
  } else {
    status[userId].withdrawing = false;
    status[userId].isWithdrawAll = false;
    status[userId].buying = false;
    status[userId].selling = false;
    status[userId].withdraw_message_id = -1;
    status[userId].amount_message_id = -1;
    status[userId].coin_address_message_id = -1;
  }
});

bot.launch();
