#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import sys
from .core import ChromiumSync


def main():
    parser = argparse.ArgumentParser(description="Chromium 通用会话同步与 SSH 隧道调度工具")
    parser.add_argument("--remote-ssh", default="root@kr2.wimotek.com", help="远程 SSH 地址 (格式: user@host)")
    parser.add_argument("--ssh-port", type=int, default=22, help="远程 SSH 端口 (默认: 22)")
    parser.add_argument("--local-port", type=int, default=9223, help="本地容器 CDP 端口 (默认: 9223)")
    parser.add_argument("--remote-port", type=int, default=9222, help="远程容器暴露的实际 CDP 端口 (默认: 9222)")
    parser.add_argument("--tunnel-port", type=int, default=9222, help="远程端口映射到本机的隧道端口 (默认: 9222)")
    parser.add_argument("--direction", choices=["push", "pull"], default=None, help="强制指定同步流向 (push/pull)")
    parser.add_argument("--timeout", type=int, default=5, help="倒计时等待秒数 (设为 0 即秒执行)")
    parser.add_argument("--auto-close", action="store_true", help="任务完成后是否关闭建立的 SSH 隧道")
    args = parser.parse_args()

    syncer = ChromiumSync(
        remote_ssh=args.remote_ssh,
        remote_ssh_port=args.ssh_port,
        local_cdp_port=args.local_port,
        remote_cdp_port=args.remote_port,
        remote_tunnel_port=args.tunnel_port,
        direction=args.direction or "push",
        timeout=args.timeout,
        auto_close_tunnel=args.auto_close
    )
    syncer.run()


if __name__ == "__main__":
    main()
