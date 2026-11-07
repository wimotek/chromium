#!/usr/bin/env python3
"""
wimotek-ssh-tunnel setup.py for PyPI distribution
"""

from setuptools import setup, find_packages
import os

with open(os.path.join(os.path.dirname(__file__), "README.md"), encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="wimotek-ssh-tunnel",
    version="1.0.0",
    author="Wimotek Engineering",
    author_email="wimotek@gmail.com",
    description="Universal SSH Tunnel & CDP Target Sync engine for Chrome DevTools Protocol Hubs with resilient error skipping and structured logging",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/wimotek/wimotek-ssh-tunnel",
    packages=find_packages(),
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: Apache Software License",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.8",
    install_requires=[
        "urllib3>=1.26.0",
    ],
    extras_require={
        "paramiko": ["paramiko>=2.11.0"],
        "sshtunnel": ["sshtunnel>=0.4.0"],
    },
    entry_points={
        "console_scripts": [
            "wimotek-ssh-tunnel=wimotek_ssh_tunnel.cli:main",
        ],
    },
)
