# 実現性の予備確認（使い捨てのスクリプト）

`docs/PLATFORM-DESIGN.md` の 12 章と付録 A の数値を出したスクリプトである。アプリのコードではなく、テストや CI の対象にもしていない。設計書に書いた事実を、後から同じ手順で確かめられるように残している。

## 確かめたこと

- `probe_structure.py`: 円孔のある平板を OCCT で作って STEP に書き出す。同じ STEP を Gmsh が読み、面を面積と重心で突き合わせる。面に名前を付けて四面体メッシュを作り、CalculiX で計算して、応力集中係数を近似式と比べる。最後に、穴の径と位置を変えた形状で、面を追跡できるかを確かめる
- `probe_flow.sh`: Gmsh で inlet・outlet・walls の名前を付けた流路のメッシュを作り、OpenFOAM の `gmshToFoam` と `checkMesh` にかける

## 実行した環境（2026-11-12）

- Linux x86-64、4 コア、メモリ 15 GB
- Python 3.13、cadquery-ocp 8.0.1.1.0、gmsh 4.15.2、numpy
- CalculiX 2.21（Ubuntu の `calculix-ccx`）、OpenFOAM v1912（Ubuntu の `openfoam`）

M1 Mac と Windows では実行していない。

## 手順

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install cadquery-ocp gmsh numpy
python probe_structure.py 6     # 引数は最大の要素寸法 [mm]。10・6・4・3 で実行した
./probe_flow.sh
```

## 注意

- 計算結果は、まれに誤ることがある。設計書の 7 章に書いたとおり、最大寸法 4 mm の計算で 1 回だけ反力が約 10.7% ずれた。おかしな値が出たら、同じ入力でもう一度実行して比べる
- スクリプトは、OCCT 7 系と 8 系の両方の書き方に対応させている（`TopoDS.Face_s` と `TopoDS.Face`）
