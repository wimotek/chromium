# -*- coding: utf-8 -*-
"""
Xray Manager & Process Watchdog
处理 REALITY 密钥推导、ShortId 生成、语法预检安全替换、核心看门狗
"""
import os
import json
import secrets
import subprocess
import signal
import time
from typing import Tuple, Optional, Dict, Any
from .config import AppConfig

class XrayManager:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self._ensure_dirs()
        self.private_key, self.public_key = self._load_or_generate_reality_keys()
        self.short_id = self._load_or_generate_short_id()
        self.node_id = self._load_or_generate_node_id()

    def _ensure_dirs(self):
        os.makedirs(AppConfig.DATA_DIR, exist_ok=True)

    def _load_or_generate_short_id(self) -> str:
        if os.path.exists(AppConfig.SHORT_ID_FILE):
            with open(AppConfig.SHORT_ID_FILE, "r") as f:
                sid = f.read().strip()
                if len(sid) == 16:
                    return sid
        sid = secrets.token_hex(8)
        with open(AppConfig.SHORT_ID_FILE, "w") as f:
            f.write(sid + "\n")
        return sid

    def _load_or_generate_node_id(self) -> str:
        if os.path.exists(AppConfig.NODE_ID_FILE):
            with open(AppConfig.NODE_ID_FILE, "r") as f:
                nid = f.read().strip()
                if nid:
                    return nid
        nid = secrets.token_hex(8)
        with open(AppConfig.NODE_ID_FILE, "w") as f:
            f.write(nid + "\n")
        return nid

    def _load_or_generate_reality_keys(self) -> Tuple[str, str]:
        """
        加载或使用 xray x25519 生成 REALITY 私钥与客户端匹配的真实公钥
        """
        # 优先从现存 config.json 提取私钥
        priv_key = ""
        pub_key = ""

        if os.path.exists(AppConfig.CONFIG_FILE):
            try:
                with open(AppConfig.CONFIG_FILE, "r") as f:
                    data = json.load(f)
                    for ib in data.get("inbounds", []):
                        rs = ib.get("streamSettings", {}).get("realitySettings", {})
                        if rs.get("privateKey"):
                            priv_key = rs["privateKey"].strip()
                            break
            except Exception:
                pass

        if os.path.exists(AppConfig.PUBLIC_KEY_FILE):
            with open(AppConfig.PUBLIC_KEY_FILE, "r") as f:
                first_line = f.readline().strip()
                if len(first_line) >= 42:
                    pub_key = first_line

        # 如果已有私钥但无公钥，通过 xray x25519 -i 推导公钥
        if priv_key and not pub_key:
            try:
                res = subprocess.run(["/usr/bin/xray", "x25519", "-i", priv_key], capture_output=True, text=True)
                for line in res.stdout.splitlines():
                    if "Password" in line or "Public" in line:
                        pub_key = line.split()[-1].strip()
                        break
            except Exception:
                pass

        # 首次部署或密钥丢失，生成全新密钥对
        if not priv_key or not pub_key:
            try:
                res = subprocess.run(["/usr/bin/xray", "x25519"], capture_output=True, text=True)
                for line in res.stdout.splitlines():
                    if "Private" in line:
                        priv_key = line.split()[-1].strip()
                    elif "Public" in line or "Password" in line:
                        pub_key = line.split()[-1].strip()
            except Exception:
                pass

        # 写入持久化公钥文档（首行纯净公钥）
        if pub_key:
            content = f"{pub_key}\n\n# ================================================================\n# Xray REALITY 客户端真实配对公钥\n# ================================================================\n"
            with open(AppConfig.PUBLIC_KEY_FILE, "w") as f:
                f.write(content)

        return priv_key, pub_key

    def test_config_syntax(self, config_dict: Dict[str, Any]) -> bool:
        """核心语法预检：xray test -config"""
        tmp_path = os.path.join(AppConfig.DATA_DIR, "xray.preflight.json")
        try:
            with open(tmp_path, "w") as f:
                json.dump(config_dict, f, indent=2)
            # Xray 官方 CLI 语法为: xray -test -config <file>
            res = subprocess.run(["/usr/bin/xray", "-test", "-config", tmp_path], capture_output=True, text=True)
            if res.returncode == 0:
                return True
            # 兼容个别版本可能支持的 xray run -test
            res_alt = subprocess.run(["/usr/bin/xray", "run", "-test", "-config", tmp_path], capture_output=True, text=True)
            if res_alt.returncode == 0:
                return True
            print(f"[Xray] 语法校验失败: {res.stderr.strip() or res.stdout.strip()}", flush=True)
            return False
        except Exception as e:
            print(f"[Xray] 预检异常: {e}", flush=True)
            return False
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

    def apply_config(self, config_dict: Dict[str, Any]) -> bool:
        """通过语法校验后无缝存盘并平滑重载核心"""
        if not self.test_config_syntax(config_dict):
            print("[Xray] 配置未通过语法校验，保持原有配置，拒绝加载！", flush=True)
            return False

        new_data_str = json.dumps(config_dict, sort_keys=True)
        old_data_str = ""
        if os.path.exists(AppConfig.CONFIG_FILE):
            try:
                with open(AppConfig.CONFIG_FILE, "r") as f:
                    old_data_str = json.dumps(json.load(f), sort_keys=True)
            except Exception:
                pass

        if new_data_str != old_data_str:
            # 修复：将临时文件直接创建在 /data 目录下（与目标文件在同一挂载盘/文件系统）
            tmp_write = f"{AppConfig.CONFIG_FILE}.tmp"
            with open(tmp_write, "w") as f:
                json.dump(config_dict, f, indent=2)
            
            try:
                os.replace(tmp_write, AppConfig.CONFIG_FILE)
            except OSError:
                import shutil
                shutil.move(tmp_write, AppConfig.CONFIG_FILE)

            print("[Xray] ✅ 配置文件更新存盘，平滑重启核心中...", flush=True)
            self.restart()
            return True
        return False

    def start(self):
        """启动 Xray 进程"""
        if self.proc and self.proc.poll() is None:
            return
        if not os.path.exists(AppConfig.CONFIG_FILE):
            print("[Xray] 警告: 配置文件不存在，无法启动", flush=True)
            return

        cmd = ["/usr/bin/xray", "run", "-config", AppConfig.CONFIG_FILE]
        self.proc = subprocess.Popen(cmd)
        print(f"[Xray] Xray 核心已启动，PID: {self.proc.pid}", flush=True)

    def restart(self):
        """平滑重启 Xray 进程"""
        self.stop()
        self.start()

    def stop(self):
        """安全停机"""
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.send_signal(signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
        self.proc = None

    def poll_watchdog(self):
        """看门狗自愈检查"""
        if self.proc is None or self.proc.poll() is not None:
            exit_code = self.proc.poll() if self.proc else "None"
            print(f"[Watchdog] 发现 Xray 核心脱机 (ExitCode: {exit_code})，看门狗秒级拉起恢复...", flush=True)
            self.start()
