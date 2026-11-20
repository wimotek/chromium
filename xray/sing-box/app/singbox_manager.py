# -*- coding: utf-8 -*-
"""
Sing-box Manager & Process Watchdog
处理 REALITY X25519 密钥对、ShortId、Hysteria2 自签 TLS 证书、语法预检安全替换与核心看门狗
"""
import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
from typing import Tuple, Optional, Dict, Any

from .config import AppConfig


class SingboxManager:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self._ensure_dirs()
        self.private_key, self.public_key = self._load_or_generate_reality_keys()
        self.short_id = self._load_or_generate_short_id()
        self.node_id = self._load_or_generate_node_id()
        self.hy2_cert_sha256 = ""
        self.hy2_cert_path, self.hy2_key_path = self.ensure_hy2_certificates(AppConfig.HY2_SNI)

    def _ensure_dirs(self):
        os.makedirs(AppConfig.DATA_DIR, exist_ok=True)

    def _load_or_generate_short_id(self) -> str:
        if os.path.exists(AppConfig.SHORT_ID_FILE):
            with open(AppConfig.SHORT_ID_FILE, "r", encoding="utf-8") as f:
                sid = f.read().strip()
                if len(sid) == 16:
                    return sid
        sid = secrets.token_hex(8)
        with open(AppConfig.SHORT_ID_FILE, "w", encoding="utf-8") as f:
            f.write(sid + "\n")
        return sid

    def _load_or_generate_node_id(self) -> str:
        if os.path.exists(AppConfig.NODE_ID_FILE):
            with open(AppConfig.NODE_ID_FILE, "r", encoding="utf-8") as f:
                nid = f.read().strip()
                if nid:
                    return nid
        nid = secrets.token_hex(8)
        with open(AppConfig.NODE_ID_FILE, "w", encoding="utf-8") as f:
            f.write(nid + "\n")
        return nid

    def _derive_public_key(self, private_key: str) -> str:
        try:
            res = subprocess.run(
                ["/usr/bin/sb-helper", "x25519-pub", "--private", private_key],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode == 0:
                val = res.stdout.strip()
                if len(val) >= 42:
                    return val
        except Exception:
            pass
        return ""

    def _load_or_generate_reality_keys(self) -> Tuple[str, str]:
        """加载或使用 sing-box generate reality-keypair 生成 REALITY X25519 密钥对"""
        priv_key = ""
        pub_key = ""

        # 1. 优先从独立私钥文件或现有 config.json 提取私钥
        if os.path.exists(AppConfig.PRIVATE_KEY_FILE):
            try:
                with open(AppConfig.PRIVATE_KEY_FILE, "r", encoding="utf-8") as f:
                    val = f.readline().strip()
                    if len(val) >= 42:
                        priv_key = val
            except Exception:
                pass

        if not priv_key and os.path.exists(AppConfig.CONFIG_FILE):
            try:
                with open(AppConfig.CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for ib in data.get("inbounds", []):
                        rk = ib.get("tls", {}).get("reality", {}).get("private_key", "")
                        if rk:
                            priv_key = rk.strip()
                            break
            except Exception:
                pass

        if os.path.exists(AppConfig.PUBLIC_KEY_FILE):
            try:
                with open(AppConfig.PUBLIC_KEY_FILE, "r", encoding="utf-8") as f:
                    first_line = f.readline().strip()
                    if len(first_line) >= 42:
                        pub_key = first_line
            except Exception:
                pass

        # 2. 若有私钥但无公钥，通过 sb-helper x25519-pub 精确推导公钥
        if priv_key and not pub_key:
            pub_key = self._derive_public_key(priv_key)

        # 3. 首次部署或密钥丢失，调用 sing-box generate reality-keypair 生成新密钥对
        if not priv_key or not pub_key:
            try:
                res = subprocess.run(
                    ["/usr/bin/sing-box", "generate", "reality-keypair"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                for line in res.stdout.splitlines():
                    clean = line.strip().replace('"', "").replace(",", "")
                    if clean.startswith("PrivateKey:"):
                        priv_key = clean.split(":", 1)[1].strip()
                    elif clean.startswith("PublicKey:"):
                        pub_key = clean.split(":", 1)[1].strip()
            except Exception as e:
                print(f"[Sing-box] REALITY 密钥生成异常: {e}", flush=True)

        if priv_key:
            with open(AppConfig.PRIVATE_KEY_FILE, "w", encoding="utf-8") as f:
                f.write(priv_key + "\n")
            try:
                os.chmod(AppConfig.PRIVATE_KEY_FILE, 0o600)
            except Exception:
                pass

        if pub_key:
            content = (
                f"{pub_key}\n\n"
                "# ================================================================\n"
                "# Sing-box REALITY 客户端真实配对公钥\n"
                "# ================================================================\n"
            )
            with open(AppConfig.PUBLIC_KEY_FILE, "w", encoding="utf-8") as f:
                f.write(content)

        return priv_key, pub_key

    @staticmethod
    def compute_cert_sha256(cert_path: str) -> str:
        """计算 PEM 叶子证书 DER 的 64 位小写 Hex SHA-256 指纹（适配 Xray 26.2.6+ / v2rayNG pinSHA256）"""
        if not cert_path or not os.path.exists(cert_path):
            return ""
        try:
            with open(cert_path, "r", encoding="utf-8") as f:
                lines = []
                in_cert = False
                for line in f:
                    s = line.strip()
                    if s == "-----BEGIN CERTIFICATE-----":
                        in_cert = True
                        lines = []
                        continue
                    if s == "-----END CERTIFICATE-----" and in_cert:
                        break
                    if in_cert and s:
                        lines.append(s)
            if not lines:
                return ""
            der_bytes = base64.b64decode("".join(lines))
            return hashlib.sha256(der_bytes).hexdigest().lower()
        except Exception:
            return ""

    def ensure_hy2_certificates(self, sni: str) -> Tuple[str, str]:
        """确保 Hysteria2 使用的 TLS 证书存在；未挂载外部证书时自动通过 sb-helper 生成 ECDSA 自签证书"""
        cert_path, key_path = AppConfig.get_effective_hy2_cert_paths()
        if os.path.exists(cert_path) and os.path.exists(key_path):
            self.hy2_cert_sha256 = self.compute_cert_sha256(cert_path)
            return cert_path, key_path

        # 若用户显式指定了自定义证书路径但文件尚未挂载，回退使用自动自签证书防止启动失败
        if AppConfig.HY2_CERT_PATH and AppConfig.HY2_KEY_PATH:
            print(
                f"[Sing-box] ⚠️ 自定义 Hysteria2 证书不存在 ({cert_path} / {key_path})，自动回退生成自签证书",
                flush=True,
            )
            cert_path = AppConfig.AUTO_HY2_CERT_FILE
            key_path = AppConfig.AUTO_HY2_KEY_FILE
            AppConfig.HY2_INSECURE = True
            if os.path.exists(cert_path) and os.path.exists(key_path):
                self.hy2_cert_sha256 = self.compute_cert_sha256(cert_path)
                return cert_path, key_path

        target_sni = (sni or AppConfig.HY2_SNI or "www.bing.com").strip()
        try:
            res = subprocess.run(
                [
                    "/usr/bin/sb-helper",
                    "gencert",
                    "--sni",
                    target_sni,
                    "--cert",
                    cert_path,
                    "--key",
                    key_path,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if res.returncode == 0:
                print(f"[Sing-box] 🔐 已自动生成 Hysteria2 ECDSA TLS 自签证书 (SNI: {target_sni})", flush=True)
            else:
                print(f"[Sing-box] ❌ 生成 Hysteria2 证书失败: {res.stderr.strip()}", flush=True)
        except Exception as e:
            print(f"[Sing-box] ❌ 生成 Hysteria2 证书异常: {e}", flush=True)

        self.hy2_cert_sha256 = self.compute_cert_sha256(cert_path)
        return cert_path, key_path

    def test_config_syntax(self, config_dict: Dict[str, Any]) -> bool:
        """核心语法预检：sing-box check -c"""
        tmp_path = os.path.join(AppConfig.DATA_DIR, "singbox.preflight.json")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(config_dict, f, indent=2)
            res = subprocess.run(
                ["/usr/bin/sing-box", "check", "-c", tmp_path],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if res.returncode == 0:
                return True
            print(f"[Sing-box] 语法校验失败: {res.stderr.strip() or res.stdout.strip()}", flush=True)
            return False
        except Exception as e:
            print(f"[Sing-box] 预检异常: {e}", flush=True)
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
            print("[Sing-box] 配置未通过语法校验，保持原有配置，拒绝加载！", flush=True)
            return False

        new_data_str = json.dumps(config_dict, sort_keys=True)
        old_data_str = ""
        if os.path.exists(AppConfig.CONFIG_FILE):
            try:
                with open(AppConfig.CONFIG_FILE, "r", encoding="utf-8") as f:
                    old_data_str = json.dumps(json.load(f), sort_keys=True)
            except Exception:
                pass

        if new_data_str != old_data_str:
            tmp_write = f"{AppConfig.CONFIG_FILE}.tmp"
            with open(tmp_write, "w", encoding="utf-8") as f:
                json.dump(config_dict, f, indent=2)

            try:
                os.replace(tmp_write, AppConfig.CONFIG_FILE)
            except OSError:
                shutil.move(tmp_write, AppConfig.CONFIG_FILE)

            if self.proc and self.proc.poll() is None:
                print("[Sing-box] ✅ 配置文件更新存盘，平滑重启核心中...", flush=True)
                self.restart()
            else:
                print("[Sing-box] ✅ 配置文件已校验存盘。", flush=True)
            return True
        return False

    def start(self):
        """启动 sing-box 进程"""
        if self.proc and self.proc.poll() is None:
            return
        if not os.path.exists(AppConfig.CONFIG_FILE):
            print("[Sing-box] 警告: 配置文件不存在，无法启动", flush=True)
            return

        cmd = ["/usr/bin/sing-box", "run", "-c", AppConfig.CONFIG_FILE]
        self.proc = subprocess.Popen(cmd)
        print(f"[Sing-box] Sing-box 核心已启动，PID: {self.proc.pid}", flush=True)

    def restart(self):
        """平滑重启 sing-box 进程"""
        self.stop()
        self.start()

    def stop(self):
        """安全停机（确保旧进程完全退出释放端口后再返回）"""
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.send_signal(signal.SIGTERM)
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                    self.proc.wait(timeout=3)
                except Exception:
                    pass
        self.proc = None

    def poll_watchdog(self):
        """看门狗自愈检查"""
        if self.proc is None or self.proc.poll() is not None:
            exit_code = self.proc.poll() if self.proc else "None"
            print(f"[Watchdog] 发现 Sing-box 核心脱机 (ExitCode: {exit_code})，看门狗秒级拉起恢复...", flush=True)
            self.start()
