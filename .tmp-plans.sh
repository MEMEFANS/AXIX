#!/bin/bash
echo '=== /api/a-token/plans 响应计时(x3, 直连8082) ==='
for i in 1 2 3; do
  curl -o /tmp/plans.json -s -w "try total:%{time_total}s http:%{http_code}\n" http://127.0.0.1:8082/api/a-token/plans
done
echo
echo '=== plans 返回内容关键字段 ==='
python3 -c "
import json
d = json.load(open('/tmp/plans.json'))
print('paymentMode:', d.get('paymentMode'))
print('activationEnabled:', d.get('activationEnabled'))
for p in d.get('activation', []):
    print('套餐: plan=%s name=%s aix=%s days=%s total=%s minerPlan=%s' % (p.get('plan'), p.get('name'), p.get('aix'), p.get('days'), p.get('total'), p.get('minerPlan')))
"
echo
echo '=== 通过nginx域名计时 ==='
curl -k -o /dev/null -s -w 'https plans total:%{time_total}s http:%{http_code}\n' https://axix.cc/api/a-token/plans
echo
echo '=== 当前node CPU(5秒增量) ==='
PID=$(pgrep -f 'node src/server.js' | head -1)
t1=$(awk '{print $14+$15}' /proc/$PID/stat)
sleep 5
t2=$(awk '{print $14+$15}' /proc/$PID/stat)
echo "5秒烧 $((t2-t1)) ticks ≈ $(( (t2-t1)*20/100 ))%"
uptime
