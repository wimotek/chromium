#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chromium Sync CLI (现代多节点调度版)
"""

import argparse
import json
import os
import sys
try:
    from .core import ChromiumSync, NodeConfig
except (ImportError, ValueError):
    from core import ChromiumSync, NodeConfig


def parse_node_str(val: str) -> dict:
    """
    解析内联节点定义参数:
    例如:
      --node id=local,port=9222
      --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa
      --node id=sg1,ssh=ubuntu@sg1.wimotek.com,port=9222,pass=Secret123
      --node '{"id": "local", "cdp_port": 9222}'
    """
    val = val.strip()
    if val.startswith("{") and val.endswith("}"):
        return json.loads(val)

    res = {}
    for part in val.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            k = k.strip().lower()
            v = v.strip()
            if k in ("port", "cdp_port"):
                res["cdp_port"] = int(v)
            elif k in ("ssh_port",):
                res["ssh_port"] = int(v)
            elif k in ("tunnel_port",):
                res["tunnel_port"] = int(v)
            elif k in ("local", "is_local"):
                res["is_local"] = v.lower() in ("true", "1", "yes")
            elif k in ("host", "cdp_host"):
                res["cdp_host"] = v
            elif k in ("ssh", "ssh_host"):
                if "@" in v:
                    user, host = v.split("@", 1)
                    res["ssh_user"] = user
                    res["ssh_host"] = host
                else:
                    res["ssh_host"] = v
            elif k in ("user", "ssh_user"):
                res["ssh_user"] = v
            elif k in ("key", "ssh_key", "ssh_key_path"):
                res["ssh_key"] = v
            elif k in ("pass", "password", "ssh_pass", "ssh_password"):
                res["ssh_password"] = v
            elif k in ("id", "name"):
                res[k] = v
            else:
                res[k] = v

    if "id" not in res:
        res["id"] = res.get("name") or res.get("ssh_host") or "local"
    return res


def main():
    parser = argparse.ArgumentParser(
        description="现代多节点 Chromium 会话同步与 Cookie 集群调度工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用示例:
  # 1. 过滤仅同步指定业务域名 (如 google, twitter, github)
  chromium-sync --config cluster.json --include-domains google.com twitter.com github.com --mode merge

  # 2. 排除广告/统计类无关域名 (如 doubleclick, google-analytics)
  chromium-sync --config cluster.json --exclude-domains doubleclick.net google-analytics.com --mode merge

  # 3. 快速查看过滤后的节点状态与 Cookie 数量 (ASCII 表格)
  chromium-sync --node id=local,port=9222 --node id=kr2,ssh=root@kr2.wimotek.com,port=9222,key=~/.ssh/id_rsa --status

  # 4. 导出节点状态与 Cookie 详情为 JSON (便于程序直接提取 Cookie 列表)
  chromium-sync --config cluster.json --status --json

  # 5. 全节点 Cookie 智能 Merge (合并所有节点并保留最新有效期，默认启用指纹差量 Diff)
  chromium-sync --config cluster.json --mode merge
        """
    )

    # 节点输入方式
    parser.add_argument("--config", help="集群节点配置文件路径 (JSON 格式)")
    parser.add_argument("--node", action="append", default=[], help="定义节点 (可多次传入，如 id=local,port=9222)")
    parser.add_argument("--nodes", help="JSON 数组格式的节点配置字符串")

    # 全局默认 SSH 凭据
    parser.add_argument("--ssh-key", help="集群默认 SSH 私钥 (支持私钥文件绝对路径 或 私钥 PEM 文本内容)")
    parser.add_argument("--ssh-password", help="集群默认 SSH 连接密码")

    # 域名过滤机制
    parser.add_argument("--include-domains", nargs="*", default=None,
                        help="域名白名单过滤列表 (如: google.com twitter.com github.com)")
    parser.add_argument("--exclude-domains", nargs="*", default=None,
                        help="域名黑名单过滤列表 (如: doubleclick.net google-analytics.com)")

    # 差量写入策略
    parser.add_argument("--no-diff", action="store_true", help="禁用指纹差量检测，强制全量覆写目标节点 Cookie")

    # 同步模式
    parser.add_argument("--mode", choices=["sync", "merge"], default="sync",
                        help="同步方式: 'merge'(合并所有节点最新Cookie), 'sync'(单源广播同步，默认)")
    parser.add_argument("--source", default=None, help="sync 模式下的源节点 ID (默认第一个节点)")
    parser.add_argument("--targets", nargs="*", default=None, help="sync 模式下的目标节点 ID 列表 (默认其余所有节点)")

    # 探测与数据查询
    parser.add_argument("--status", action="store_true", help="仅探测并输出各节点的 Cookie 数与详情表格，不执行写入")
    parser.add_argument("--json", action="store_true", help="以 JSON 格式输出节点数据或执行结果指标")

    # 隧道与连接
    parser.add_argument("--auto-close", action="store_true", help="任务完成后关闭拉起的 SSH 隧道")
    parser.add_argument("-v", "--verbose", action="store_true", help="显示详细调试日志")

    args = parser.parse_args()

    # 聚合节点配置
    raw_nodes = []
    if args.config:
        if not os.path.exists(args.config):
            sys.exit(f"[-] 配置文件不存在: {args.config}")
        with open(args.config, "r", encoding="utf-8") as f:
            raw_nodes.extend(json.load(f))

    if args.nodes:
        raw_nodes.extend(json.loads(args.nodes))

    if args.node:
        for n_str in args.node:
            raw_nodes.append(parse_node_str(n_str))

    # 默认兜底：若未传入任何节点参数，尝试使用标准默认本地节点
    if not raw_nodes:
        raw_nodes = [
            {"id": "local", "name": "本地容器", "is_local": True, "cdp_port": 9222}
        ]

    syncer = ChromiumSync(
        nodes=raw_nodes,
        mode=args.mode,
        source=args.source,
        targets=args.targets,
        include_domains=args.include_domains,
        exclude_domains=args.exclude_domains,
        diff=(not args.no_diff),
        ssh_key=args.ssh_key,
        ssh_password=args.ssh_password,
        auto_close_tunnel=args.auto_close,
        verbose=args.verbose
    )

    if args.status:
        report = syncer.inspect()
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(syncer.get_summary_table(report))
        return

    result = syncer.run()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
