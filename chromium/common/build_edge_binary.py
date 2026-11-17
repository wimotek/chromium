#!/usr/bin/env python3
"""
将 common/edge_node_client.py 编译为原生 ELF 可执行文件与剥离符号的 .so 动态库，
确保运行时镜像不包含 edge_node_client.py 源码或中间产物。
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
    for p in ("/opt", exe_dir):
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    for sp in glob.glob("/opt/venv/lib/python*/site-packages"):
        if os.path.isdir(sp) and sp not in sys.path:
            sys.path.insert(1, sp)


def _run_self_test():
    import importlib.util
    import httpx
    import websockets
    import edge_node_client

    spec = importlib.util.find_spec("edge_node_client")
    origin = getattr(spec, "origin", "") if spec else ""
    if not origin.endswith(".so"):
        raise RuntimeError(f"Expected compiled .so for edge_node_client, got: {origin}")

    if not hasattr(edge_node_client, "run_edge_lifecycle") or not hasattr(edge_node_client, "main"):
        raise RuntimeError("Compiled edge_node_client missing required entrypoints")

    if hasattr(edge_node_client, "sync_hub_bookmarks_to_chromium"):
        raise RuntimeError("Bookmark helper should have been removed from edge_node_client")

    print(
        f"[Edge Binary Self-Test OK] origin={origin}, "
        f"httpx={httpx.__version__}, websockets={websockets.__version__}"
    )


def main():
    _bootstrap_paths()
    if "--self-test" in sys.argv:
        _run_self_test()
        return
    import edge_node_client
    edge_node_client.main()


if __name__ == "__main__":
    main()
"""


def _compile_extension(src_file: str, out_dir: str, build_tmp: str):
    c_build_dir = os.path.join(build_tmp, "cython_c")
    temp_dir = os.path.join(build_tmp, "build_temp")
    os.makedirs(c_build_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)

    ext = Extension(
        name="edge_node_client",
        sources=[src_file],
        extra_compile_args=["-O3", "-fno-strict-aliasing"],
    )
    ext_modules = cythonize(
        [ext],
        build_dir=c_build_dir,
        compiler_directives=COMPILER_DIRECTIVES,
        quiet=False,
    )

    src_dir = os.path.dirname(src_file)
    orig_cwd = os.getcwd()
    try:
        os.chdir(src_dir)
        setup(
            name="edge_node_client_binary",
            ext_modules=ext_modules,
            script_args=[
                "build_ext",
                f"--build-lib={out_dir}",
                f"--build-temp={temp_dir}",
            ],
        )
    finally:
        os.chdir(orig_cwd)


def _compile_launcher_binary(out_bin: str, build_tmp: str):
    pyx_path = os.path.join(build_tmp, "_edge_launcher.pyx")
    c_path = os.path.join(build_tmp, "_edge_launcher.c")

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
        lib_dir = sysconfig.get_config_var("LIBDIR") or "/usr/lib"
        cmd = ["gcc", "-O3", *inc_flags, c_path, f"-Wl,-rpath,{lib_dir}", *ld_flags, "-o", out_bin]
    else:
        inc_dir = sysconfig.get_path("include")
        plat_inc_dir = sysconfig.get_path("platinclude")
        lib_dir = sysconfig.get_config_var("LIBDIR") or "/usr/lib"
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

    print(f"[Compile Edge Launcher] {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    os.chmod(out_bin, 0o755)


def _strip_and_verify(out_dir: str, out_bin: str):
    strip_bin = shutil.which("strip")
    so_files = []
    for fname in os.listdir(out_dir):
        if fname.startswith("edge_node_client") and fname.endswith(".so"):
            fpath = os.path.join(out_dir, fname)
            if strip_bin:
                subprocess.run([strip_bin, "--strip-unneeded", fpath], check=True)
            os.chmod(fpath, 0o755)
            so_files.append(fpath)
        elif fname.startswith("edge_node_client") and fname.endswith((".py", ".pyc", ".pyo", ".pyx", ".c", ".h", ".o")):
            os.remove(os.path.join(out_dir, fname))

    if strip_bin:
        subprocess.run([strip_bin, "--strip-unneeded", out_bin], check=True)

    if not so_files:
        raise RuntimeError(f"Expected compiled edge_node_client*.so in {out_dir}")

    print(f"[Verify Edge Binary] ELF={out_bin}, so_files={so_files}")


def main():
    parser = argparse.ArgumentParser(description="Compile edge_node_client.py into native ELF + stripped .so")
    parser.add_argument("--src", default="/tmp/edge_node_client.py", help="Source edge_node_client.py path")
    parser.add_argument("--out", default="/opt/edge-node-client", help="Output ELF executable path")
    args = parser.parse_args()

    src_file = os.path.abspath(args.src)
    out_bin = os.path.abspath(args.out)
    out_dir = os.path.dirname(out_bin)
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="edge_bin_build_") as build_tmp:
        _compile_extension(src_file, out_dir, build_tmp)
        _compile_launcher_binary(out_bin, build_tmp)
        _strip_and_verify(out_dir, out_bin)


if __name__ == "__main__":
    main()
