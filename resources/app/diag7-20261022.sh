#!/bin/bash
echo "=== 最近 2000 请求热点接口 ==="
tail -2000 /var/log/nginx/access.log | awk '{print $7}' | sed 's/?.*//' | sort | uniq -c | sort -rn | head -18
echo "=== team/profile 平均耗时（nginx $upstream_response_time） ==="
tail -5000 /var/log/nginx/access.log | grep 'team/profile' | tail -8 | awk '{print $NF, $(NF-1)}'
