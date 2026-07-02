process.env.RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=NO_KEY';
import('./tools/dlmm.js').then(async (m) => {
  const result = await m.getMyPositions({ wallet_address: '9qGKjN8ZQqPpDuGTLpa77K5xRe2UMw4c7m9348XpyCRf' });
  result.positions?.forEach((p, i) => {
    console.log("Position", i+1 + ":");
    console.log("  position:", p.position);
    console.log("  pair:", JSON.stringify(p.pair));
    console.log("  pool:", p.pool);
    console.log("  base_mint:", p.base_mint?.slice(0, 20));
  });
  process.exit(0);
}).catch(e => console.error('ERR:', e.message));
