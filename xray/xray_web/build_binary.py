# -*- coding: utf-8 -*-
"""
Xray-Web Hub 后端 Cython 原生二进制编译器
将全部业务 .py 模块编译为剥离调试符号的原生 ELF (.so) 扩展模块，
并清理所有业务 .py / .c / 构建缓存文件，实现闭源保护与原生运行提速。
"""
import os
import shutil
import subprocess
import sys

from Cython.Build import cythonize
from setuptools import Extension, setup

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXCLUDE_FILES = {"build_binary.py"}
KEEP_INIT_FILES = {
    os.path.join("core", "__init__.py"),
    os.path.join("routes", "__init__.py"),
    os.path.join("services", "__init__.py"),
}


def collect_extensions() -> tuple[list[Extension], list[str]]:
    extensions: list[Extension] = []
    compiled_py_paths: list[str] = []

    for root, _, files in os.walk(BASE_DIR):
        if "__pycache__" in root or os.path.basename(root) == "build":
            continue
        for fname in sorted(files):
            if not fname.endswith(".py") or fname in EXCLUDE_FILES:
                continue
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, BASE_DIR)
            if rel_path in KEEP_INIT_FILES:
                continue

            mod_name = rel_path[:-3].replace(os.sep, ".")
            extensions.append(
                Extension(
                    mod_name,
                    [full_path],
                    extra_compile_args=["-O2", "-Wno-unused-function"],
                )
            )
            compiled_py_paths.append(full_path)

    return extensions, compiled_py_paths


def main():
    os.chdir(BASE_DIR)
    extensions, compiled_py_paths = collect_extensions()
    if not extensions:
        raise RuntimeError("未找到任何待编译的后端 .py 模块")

    nthreads = max(1, min(8, os.cpu_count() or 2))
    print(f"==> [Cython Build] 准备并行编译 {len(extensions)} 个核心模块 (threads={nthreads})...", flush=True)

    ext_modules = cythonize(
        extensions,
        nthreads=nthreads,
        compiler_directives={
            "language_level": "3",
            "binding": True,
            "embedsignature": False,
            "docstrings": False,
            "annotation_typing": False,
        },
        quiet=False,
    )

    sys.argv = [sys.argv[0], "build_ext", "--inplace", f"-j{nthreads}"]
    setup(name="xray_web_hub", ext_modules=ext_modules)

    # 1. 删除所有源码 .py、中间 .c、build 目录与 __pycache__
    for py_path in compiled_py_paths:
        if os.path.exists(py_path):
            os.remove(py_path)

    for root, dirs, files in os.walk(BASE_DIR):
        for fname in files:
            full = os.path.join(root, fname)
            if fname.endswith(".c") or fname.endswith(".pyc") or fname == "build_binary.py":
                os.remove(full)
            elif fname.endswith(".so"):
                subprocess.run(["strip", "--strip-unneeded", full], check=False)
        for dname in list(dirs):
            if dname in ("build", "__pycache__"):
                shutil.rmtree(os.path.join(root, dname), ignore_errors=True)
                dirs.remove(dname)

    req_file = os.path.join(BASE_DIR, "requirements.txt")
    if os.path.exists(req_file):
        os.remove(req_file)

    # 2. 对 core/__init__.py 与 services/__init__.py 清空内容为 0 字节包标记
    for pkg_init in ("core/__init__.py", "services/__init__.py"):
        p = os.path.join(BASE_DIR, pkg_init)
        if os.path.exists(p):
            with open(p, "w", encoding="utf-8"):
                pass

    so_count = sum(1 for r, _, fs in os.walk(BASE_DIR) for f in fs if f.endswith(".so"))
    print(f"==> [Cython Build] ✅ 编译完成！共生成 {so_count} 个原生 .so 二进制模块，所有源码已清除。", flush=True)


if __name__ == "__main__":
    main()
