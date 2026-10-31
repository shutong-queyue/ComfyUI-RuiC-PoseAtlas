"""ComfyUI Manager 安装钩子：仅检查依赖，不下载任何素材。

素材由节点在运行时按需从上游 CDN 拉取并缓存到 .cache/，
因此这里不需要克隆任何仓库。
"""

import subprocess
import sys

REQUIRED = ["pillow", "numpy"]


def _missing():
    names = {"pillow": "PIL", "numpy": "numpy"}
    out = []
    for pkg in REQUIRED:
        try:
            __import__(names[pkg])
        except ImportError:
            out.append(pkg)
    return out


def main():
    miss = _missing()
    if not miss:
        return
    print(f"[RuiC PoseAtlas] 安装依赖：{', '.join(miss)}")
    subprocess.run([sys.executable, "-m", "pip", "install", *miss], check=False)


if __name__ == "__main__":
    main()
