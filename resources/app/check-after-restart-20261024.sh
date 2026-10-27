#!/bin/bash
echo "=== 服务状态 ==="
systemctl is-active wg-platform.service
systemctl show wg-platform.service -p ActiveState,SubState,MainPID | tr '\n' ' '; echo
echo
echo "=== 端口 8082 ==="
ss -ltnp | grep 8082 || echo "8082 未监听"
echo
echo "=== 健康接口探测 ==="
curl -s -o /dev/null -w 'health=%{http_code} %{time_total}s\n' --max-time 5 http://127.0.0.1:8082/api/health
curl -s -o /dev/null -w 'plans=%{http_code} %{time_total}s\n' --max-time 8 http://127.0.0.1:8082/api/a-token/plans
curl -s -o /dev/null -w 'pool=%{http_code} %{time_total}s\n' --max-time 8 http://127.0.0.1:8082/api/a-token/pool
curl -s -o /dev/null -w 'home=%{http_code} %{time_total}s\n' --max-time 8 http://127.0.0.1:8082/
echo
echo "=== 当前进程启动时间 ==="
ps -o pid,lstart,cmd -p $(pgrep -f 'node.*server.js' | head -1) 2>/dev/null || ps aux | grep -m2 'node.*server'
echo
echo "=== stdout 日志尾（确认本次启动成功）==="
tail -8 /opt/wg-platform/logs/server.stdout.log
echo
echo "=== 外网入口 ==="
curl -s -o /dev/null -w 'axix.cc=%{http_code} %{time_total}s\n' --max-time 10 https://axix.cc/
