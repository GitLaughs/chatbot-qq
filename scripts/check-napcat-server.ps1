param(
    [string]$Server = "root@43.108.37.203"
)

$ErrorActionPreference = "Continue"

ssh $Server @'
echo "== Feishu service must remain active =="
systemctl is-active cc-connect || true

echo
echo "== QQ services =="
systemctl is-active onebot-group-proxy cc-connect-qq 2>/dev/null || true

echo
echo "== Listen ports =="
ss -ltnp | grep -E '(:3001|:3002|:3003|:18081)' || true

echo
echo "== Config isolation =="
test -f /root/.cc-connect/config.toml && echo "Feishu config present: /root/.cc-connect/config.toml"
test -f /root/.cc-connect-qq/config.toml && echo "QQ config present: /root/.cc-connect-qq/config.toml"

echo
echo "== Recent QQ logs =="
tail -n 80 /var/log/onebot-group-proxy.log 2>/dev/null || true
tail -n 80 /var/log/cc-connect-qq.log 2>/dev/null || true
'@
