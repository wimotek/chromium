"""
wimotek-chromium-sync Package
Universal Chromium Session & Cookie Synchronizer with SSH Tunnel and Cluster Support
"""
from .core import ChromiumSync, NodeConfig, merge_cookies

__version__ = "1.2.0"
__all__ = ["ChromiumSync", "NodeConfig", "merge_cookies"]
