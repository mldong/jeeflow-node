#!/usr/bin/env bash
# @mldong/jeeflow 的"发出去了"核验：CI 的 npm publish 退 0 只代表 registry 收下了包，
# 解析用的 packument 元数据还要再传播几秒——09-23 首跑就是栽在这里：
# 版本 URL 已 200，紧接着 npm i 仍 ETARGET。所以这里 URL 与真装各带一轮重试。
set -euo pipefail

REF="${1:-${GITHUB_REF_NAME:-}}"
[ -n "$REF" ] || { echo "::error::没传版本号（形如 v1.8.29）"; exit 2; }
V="${REF#v}"
PKG="@mldong/jeeflow"
URL="https://registry.npmjs.org/@mldong%2Fjeeflow/${V}"

deadline=$(( $(date +%s) + 900 ))            # 15 min
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || echo 000)
  [ "$code" = "200" ] && { echo "✅ $URL 已可拉"; break; }
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::超时 15min 仍 HTTP $code — $PKG $V 在 npm 上拉不到，别当已发版"; exit 1
  fi
  echo "等待 npm 分发（当前 $code，剩余 $(( (deadline - $(date +%s)) / 60 ))min）"; sleep 20
done

d=$(mktemp -d); cd "$d"
npm init -y >/dev/null 2>&1
inst_deadline=$(( $(date +%s) + 300 ))       # 安装再给 5min：元数据分发的秒级尾
while :; do
  if npm i --no-audit --no-fund --registry=https://registry.npmjs.org/ "${PKG}@${V}" >/dev/null 2>&1; then
    echo "✅ 干净目录 npm i 成功"; break
  fi
  if [ "$(date +%s)" -ge "$inst_deadline" ]; then
    echo "::error::URL 已 200 但 npm i 仍装不到 ${PKG}@${V}（元数据未同步或包体缺失）"; exit 1
  fi
  echo "重试 npm i（剩余 $(( (inst_deadline - $(date +%s)) / 60 ))min）"; sleep 15
done

# 版本从磁盘上的 package.json 读，不用 require('pkg/package.json')——有 exports 字段的包会拒绝子路径
got=$(node -p "JSON.parse(require('fs').readFileSync('./node_modules/@mldong/jeeflow/package.json','utf8')).version")
[ "$got" = "$V" ] || { echo "::error::装到的是 $got，期望 $V"; exit 1; }
node -e "require('@mldong/jeeflow'); console.log('✅ import @mldong/jeeflow 成功，版本', process.argv[1])" "$got"
