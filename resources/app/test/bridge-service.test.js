import assert from 'node:assert/strict';
import { createBridgeService } from '../src/bridge-service.js';

const wallet = '0x00000000000000000000000000000000000000A1';
const treasury = '0x00000000000000000000000000000000000000D0';
const router = '0x00000000000000000000000000000000000000B1';
const ethereumUsdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const arbitrumUsdt = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
let requestedUrl = '';
const fetchImpl = async url => {
  requestedUrl = String(url);
  return {
    ok:true,
    async json() {
      return {
        tool:'across',
        action:{
          fromChainId:1, toChainId:42161,
          fromToken:{ address:ethereumUsdt }, toToken:{ address:arbitrumUsdt },
          fromAmount:'100000000', fromAddress:wallet, toAddress:treasury,
        },
        estimate:{ toAmount:'99800000', toAmountMin:'99500000', approvalAddress:router },
        transactionRequest:{ from:wallet, to:router, data:'0x1234', value:'0x0', chainId:1, gasLimit:'200000' },
      };
    },
  };
};

const service = createBridgeService({
  enabled:true,
  settlementNetwork:'arbitrum',
  depositAddress:treasury,
  allowedBridges:['across', 'stargateV2'],
  fetchImpl,
  networks:[
    { id:'ethereum', name:'Ethereum', chainId:1, tokenContract:ethereumUsdt, tokenDecimals:6 },
    { id:'arbitrum', name:'Arbitrum', chainId:42161, tokenContract:arbitrumUsdt, tokenDecimals:6 },
  ],
});

const quote = await service.depositQuote({ wallet, network:'ethereum', amount:'100' });
assert.equal(quote.tool, 'across');
assert.equal(quote.minimumReceived, '99.5');
assert.equal(quote.transactionRequest.to.toLowerCase(), router.toLowerCase());
assert.match(requestedUrl, /allowBridges=across%2CstargateV2/);
assert.deepEqual(await service.depositQuote({ wallet, network:'arbitrum', amount:'100' }), {
  mode:'direct', settlementNetwork:'arbitrum',
});

const unsafe = createBridgeService({
  enabled:true,
  settlementNetwork:'arbitrum', depositAddress:treasury, networks:[
    { id:'ethereum', chainId:1, tokenContract:ethereumUsdt, tokenDecimals:6 },
    { id:'arbitrum', chainId:42161, tokenContract:arbitrumUsdt, tokenDecimals:6 },
  ],
  fetchImpl:async () => ({ ok:true, async json() { return {
    tool:'unapproved', action:{}, estimate:{}, transactionRequest:{},
  }; } }),
});
await assert.rejects(unsafe.depositQuote({ wallet, network:'ethereum', amount:'100' }), /允许的跨链桥/);
console.log('bridge-service tests passed');
