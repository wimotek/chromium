#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
from .core import ChromiumSync


def main():
    parser = argparse.ArgumentParser(description="Chromium 一体化会话热同步工具")
    parser.add_argument("--remote-ssh", default="root@kr2.wimotek.com", help="远程 SSH 地址")
    parser.add_argument("--ssh-port", type=int, default=22, help="远程 SSH 端口")
    parser.add_argument("--local-port", type=int, default=9223, help="本地容器 CDP 端口")
    parser.add_argument("--remote-port", type=int, default=9222, help="远程容器暴露的端口")
    parser.add_argument("--tunnel-port", type=int, default=9222, help="本地隧道端口")
    parser.add_argument("--direction", choices=["push", "pull", "auto"], default=None, help="同步方向")
    parser.add_argument("--timeout", type=int, default=5, help="倒计时秒数 (设为 0 即秒执行)")
    parser.add_argument("--auto-close", action="store_true", help="任务完成后关闭 SSH 隧道")
    args = parser.parse_args()

    syncer = ChromiumSync(
        remote_ssh=args.remote_ssh,
        remote_ssh_port=args.ssh_port,
        local_cdp_port=args.local_port,
        remote_cdp_port=args.remote_port,
        remote_tunnel_port=args.tunnel_port,
        direction=args.direction or "auto",
        timeout=args.timeout,
        auto_close_tunnel=args.auto_close
    )
    syncer.run()


if __name__ == "__main__":
    main()
