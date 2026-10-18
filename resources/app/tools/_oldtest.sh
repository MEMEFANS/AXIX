rpc() { curl -s -m 20 -X POST -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$3"; }
for B in 127458536 127200000 127000000 126500000 126300000; do
  H=$(printf '0x%x' $B)
  echo -n "block $B : "
  rpc eth_getBlockByNumber "[\"$H\",false]" https://bsc-rpc.publicnode.com | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.error){console.log("ERR",j.error.message.slice(0,80));}else if(!j.result){console.log("NULL");}else{console.log("ok ts",new Date(parseInt(j.result.timestamp,16)*1000).toISOString());}}catch(e){console.log("parsefail",s.slice(0,80));}});'
done

echo
echo "=== alt RPC endpoints quick check (latest block) ==="
for U in https://bsc-dataseed.binance.org https://bsc-dataseed1.defibit.io https://1rpc.io/bnb https://bsc.publicnode.com https://binance.llamarpc.com; do
  echo -n "$U : "
  rpc eth_blockNumber "[]" "$U" | head -c 120
  echo
done
echo "=== done ==="
