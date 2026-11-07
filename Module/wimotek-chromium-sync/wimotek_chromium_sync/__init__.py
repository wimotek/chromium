"""
wimotek-chromium-sync Package
Universal Chromium Session & Cookie Synchronizer with SSH Tunnel and Cluster Support
"""
from .core import ChromiumSync, NodeConfig, merge_cookies, filter_cookies, compute_cookie_delta

__version__ = "1.3.0"
__all__ = ["ChromiumSync", "NodeConfig", "merge_cookies", "filter_cookies", "compute_cookie_delta"]
