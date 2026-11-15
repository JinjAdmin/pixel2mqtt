"""Converters shared with pixeld-h6631/tools (pure Python, no dependencies).

anim_convert.py, graffiti.py, minipng.py, icon_pack.py are copies of the tools in the pixeld-h6631
project. They contain code only: no artwork. Keep them in sync when the tools change.
"""
import pathlib
import sys

_here = str(pathlib.Path(__file__).resolve().parent)
if _here not in sys.path:  # the tools import each other as top-level modules
    sys.path.insert(0, _here)
