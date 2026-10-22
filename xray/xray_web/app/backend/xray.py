def get_reality_public_key() -> str:
    key_path = "/data/public_key.txt"
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            pk = f.read().strip()
            if pk and len(pk) > 30 and not pk.startswith("("):
                return pk

    config_path = "/data/config.json"
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            
            priv_key = ""
            for inbound in cfg.get("inbounds", []):
                reality = inbound.get("streamSettings", {}).get("realitySettings", {})
                if reality.get("privateKey"):
                    priv_key = reality["privateKey"]
                    break

            if priv_key and "CHANGE" not in priv_key:
                # 修复核心：私钥作为参数直接跟在 -i 后面，不用管道
                cmd = ["/usr/bin/xray", "x25519", "-i", priv_key]
                res = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
                for line in res.splitlines():
                    if "Public key:" in line:
                        pk = line.split("Public key:")[1].strip()
                        with open(key_path, "w", encoding="utf-8") as fw:
                            fw.write(pk)
                        return pk
        except Exception:
            pass
    return ""