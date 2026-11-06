#!/usr/bin/env python3
"""Standard setup.py shim for backward compatibility with older build tools and editable installs."""
from setuptools import setup, find_packages

setup(
    packages=find_packages(include=["wimotek_edge_agent", "wimotek_edge_agent.*"]),
    package_data={
        "wimotek_edge_agent": ["py.typed"],
    },
)
