#!/usr/bin/env python3
"""
将 Chromium Sync SaaS 后端源码编译为原生 ELF 可执行文件与剥离符号的 .so 动态库。
编译产物目录中不保留任何 .py / .pyc / .pyx / .c 源码文件。
"""
import argparse
import os
import shlex
import shutil
import subprocess
import sys
import sysconfig
import tempfile

from Cython.Build import cythonize
from setuptools import Extension, setup


COMPILER_DIRECTIVES = {
    "language_level": 3,
    "binding": True,
    "embedsignature": True,
    "annotation_typing": False,
}

LAUNCHER_PYX = """# cython: language_level=3
import glob
import os
import sys


def _bootstrap_paths():
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    candidates = [exe_dir, "/app/backend", os.getcwd()]
    for p in reversed(candidates):
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    for sp in glob.glob("/opt/venv/lib/python*/site-packages"):
        if os.path.isdir(sp) and sp not in sys.path:
            sys.path.insert(1, sp)


def _run_self_test():
    import importlib.util
    import app as saas_app
    from fastapi import Request
    from config import resolve_hub_access_info

    spec = importlib.util.find_spec("app")
    origin = getattr(spec, "origin", "") if spec else ""
    if not origin.endswith(".so"):
        raise RuntimeError(f"Expected compiled .so extension for app, got: {origin}")

    schema = saas_app.app.openapi()
    route_count = len(schema.get("paths", {}))
    if route_count < 15:
        raise RuntimeError(f"Unexpected FastAPI route count after binary compilation: {route_count}")

    fake_req = Request(
        {
            "type": "http",
            "scheme": "https",
            "headers": [(b"host", b"saas.example.com:8443")],
        }
    )
    info = resolve_hub_access_info(fake_req)
    if info.get("http_scheme") not in ("http", "https"):
        raise RuntimeError(f"resolve_hub_access_info missing http_scheme: {info}")

    print(f"[Binary Self-Test OK] origin={origin}, routes={route_count}, http_scheme={info['http_scheme']}")


def main():
    _bootstrap_paths()
    if "--self-test" in sys.argv:
        _run_self_test()
        return
    import app as saas_app
    saas_app.run_server()


if __name__ == "__main__":
    main()
"""


def _collect_extensions(src_dir: str):
    extensions = []
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = sorted(d for d in dirs if d not in {"__pycache__", "build", "dist", ".git"})
        for fname in sorted(files):
            if not fname.endswith(".py"):
                continue
            if fname == "build_binary.py":
                continue
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, src_dir).replace(os.sep, "/")
            mod_name = rel_path[:-3].replace("/", ".")
            extensions.append(
                Extension(
                    name=mod_name,
                    sources=[full_path],
                    extra_compile_args=["-O3", "-fno-strict-aliasing"],
                )
            )
    return extensions


def _compile_extensions(src_dir: str, out_dir: str, build_tmp: str):
    extensions = _collect_extensions(src_dir)
    if not extensions:
        raise RuntimeError(f"No Python modules found under {src_dir}")

    os.makedirs(out_dir, exist_ok=True)
    c_build_dir = os.path.join(build_tmp, "cython_c")
    temp_dir = os.path.join(build_tmp, "build_temp")
    os.makedirs(c_build_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)

    ext_modules = cythonize(
        extensions,
        build_dir=c_build_dir,
        compiler_directives=COMPILER_DIRECTIVES,
        nthreads=min(4, max(1, os.cpu_count() or 1)),
        quiet=False,
    )

    jobs = max(1, min(8, os.cpu_count() or 2))
    orig_cwd = os.getcwd()
    try:
        os.chdir(src_dir)
        setup(
            name="chromium_sync_saas_binary",
            ext_modules=ext_modules,
            script_args=[
                "build_ext",
                f"--build-lib={out_dir}",
                f"--build-temp={temp_dir}",
                f"-j{jobs}",
            ],
        )
    finally:
        os.chdir(orig_cwd)


def _compile_launcher_binary(out_dir: str, build_tmp: str, bin_name: str):
    pyx_path = os.path.join(build_tmp, "_launcher.pyx")
    c_path = os.path.join(build_tmp, "_launcher.c")
    out_bin = os.path.join(out_dir, bin_name)

    with open(pyx_path, "w", encoding="utf-8") as f:
        f.write(LAUNCHER_PYX)

    subprocess.run(
        [sys.executable, "-m", "cython", "-3", "--embed", "-o", c_path, pyx_path],
        check=True,
    )

    real_py = os.path.realpath(sys.executable)
    py_cfg = os.path.join(os.path.dirname(real_py), "python3-config")
    if os.path.isfile(py_cfg) and os.access(py_cfg, os.X_OK):
        inc_flags = shlex.split(subprocess.check_output([py_cfg, "--includes"], text=True))
        ld_flags = shlex.split(subprocess.check_output([py_cfg, "--ldflags", "--embed"], text=True))
        lib_dir = sysconfig.get_config_var("LIBDIR") or "/usr/local/lib"
        cmd = ["gcc", "-O3", *inc_flags, c_path, f"-Wl,-rpath,{lib_dir}", *ld_flags, "-o", out_bin]
    else:
        inc_dir = sysconfig.get_path("include")
        plat_inc_dir = sysconfig.get_path("platinclude")
        lib_dir = sysconfig.get_config_var("LIBDIR") or "/usr/local/lib"
        ld_ver = sysconfig.get_config_var("LDVERSION") or sysconfig.get_config_var("VERSION") or "3.11"
        sys_libs = shlex.split(
            " ".join(
                filter(
                    None,
                    [
                        sysconfig.get_config_var("LIBS") or "",
                        sysconfig.get_config_var("SYSLIBS") or "",
                        sysconfig.get_config_var("LIBM") or "-lm",
                    ],
                )
            )
        )
        cmd = ["gcc", "-O3", f"-I{inc_dir}"]
        if plat_inc_dir and plat_inc_dir != inc_dir:
            cmd.append(f"-I{plat_inc_dir}")
        cmd.extend([c_path, f"-L{lib_dir}", f"-Wl,-rpath,{lib_dir}", f"-lpython{ld_ver}", *sys_libs, "-o", out_bin])

    print(f"[Compile Launcher] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    os.chmod(out_bin, 0o755)
    return out_bin


def _strip_and_verify(out_dir: str, out_bin: str):
    strip_bin = shutil.which("strip")
    for root, dirs, files in os.walk(out_dir):
        for d in list(dirs):
            if d == "__pycache__":
                shutil.rmtree(os.path.join(root, d), ignore_errors=True)
                dirs.remove(d)
        for fname in files:
            fpath = os.path.join(root, fname)
            if fname.endswith((".py", ".pyc", ".pyo", ".pyx", ".c", ".h", ".o")):
                os.remove(fpath)
            elif fname.endswith(".so") and strip_bin:
                subprocess.run([strip_bin, "--strip-unneeded", fpath], check=True)

    if strip_bin:
        subprocess.run([strip_bin, "--strip-unneeded", out_bin], check=True)

    leaked = []
    so_count = 0
    for root, _, files in os.walk(out_dir):
        for fname in files:
            if fname.endswith((".py", ".pyc", ".pyo", ".pyx", ".c", ".h")):
                leaked.append(os.path.join(root, fname))
            elif fname.endswith(".so"):
                so_count += 1

    if leaked:
        raise RuntimeError(f"Source/intermediate files remained in binary output: {leaked}")
    if so_count < 20:
        raise RuntimeError(f"Expected >=20 compiled .so modules, found {so_count}")

    print(f"[Verify Binary Output] ELF={out_bin}, compiled_so_modules={so_count}, leaked_sources=0")


def main():
    parser = argparse.ArgumentParser(description="Compile SaaS backend to closed-source ELF binary + stripped .so libs")
    parser.add_argument("--src", required=True, help="Source backend directory")
    parser.add_argument("--out", required=True, help="Output binary directory")
    parser.add_argument("--bin-name", default="chromium-sync-saas", help="Executable filename")
    args = parser.parse_args()

    src_dir = os.path.abspath(args.src)
    out_dir = os.path.abspath(args.out)

    with tempfile.TemporaryDirectory(prefix="saas_bin_build_") as build_tmp:
        _compile_extensions(src_dir, out_dir, build_tmp)
        out_bin = _compile_launcher_binary(out_dir, build_tmp, args.bin_name)
        _strip_and_verify(out_dir, out_bin)


if __name__ == "__main__":
    main()
