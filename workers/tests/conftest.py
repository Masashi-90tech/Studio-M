# pytest の共通設定。workers/shape・workers/mesh・workers/tools を import できるようにする（パッケージにはしない）。
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for sub in ('shape', 'mesh', 'tools'):
    p = os.path.normpath(os.path.join(HERE, '..', sub))
    if p not in sys.path:
        sys.path.insert(0, p)
