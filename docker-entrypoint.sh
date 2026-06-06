#!/bin/sh
set -e

mkdir -p /app/data /app/logs

# Create default user-config if missing (gitignored, not in image)
if [ ! -f /app/user-config.json ]; then
  cat > /app/user-config.json << 'EOF'
{
  "maxPositions": 1,
  "deployAmountSol": 0.2,
  "maxDeployAmount": 0.2,
  "gasReserve": 0.1,
  "positionSizePct": 0.4,
  "takeProfitPct": 8,
  "stopLossPct": -30,
  "trailingTakeProfit": true,
  "trailingTriggerPct": 3,
  "trailingDropPct": 2.5,
  "solMode": false
}
EOF
fi

exec node index.js
