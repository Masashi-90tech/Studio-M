# 使い捨ての実現性確認: STEP → 面の署名 → Gmsh（別ライブラリの OCCT）で同じ面を特定 → グループ → CalculiX
import sys, json, math, subprocess, time, re, os
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.Interface import Interface_Static
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
from OCP.TopoDS import TopoDS
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.BRepAdaptor import BRepAdaptor_Surface
import gmsh

L, W, T = 400.0, 100.0, 10.0   # mm

def make_plate(d, cx=L/2, path='plate.step'):
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), L, W, T).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, W/2, -1), gp_Dir(0, 0, 1)), d/2, T+2).Shape()
    shape = BRepAlgoAPI_Cut(box, cyl).Shape()
    Interface_Static.SetCVal_s('write.step.unit', 'MM')
    w = STEPControl_Writer(); w.Transfer(shape, STEPControl_AsIs); w.Write(path)
    return shape

def signatures(shape):
    out = []; exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        f = (getattr(TopoDS,'Face_s',None) or TopoDS.Face)(exp.Current())
        g = GProp_GProps(); (getattr(BRepGProp,'SurfaceProperties_s',None) or BRepGProp.SurfaceProperties)(f, g)
        c = g.CentreOfMass()
        out.append({'type': str(BRepAdaptor_Surface(f).GetType()).split('.')[-1], 'area': g.Mass(), 'c': (c.X(), c.Y(), c.Z())})
        exp.Next()
    return out

def dist(a, b): return math.dist(a, b)

# ---- 1. 形状と署名
shape = make_plate(20.0)
sig = signatures(shape)
print('OCP 側の面:', len(sig), [ (s['type'].replace('GeomAbs_',''), round(s['area'],2)) for s in sig])

# ---- 2. Gmsh が同じ STEP を独立に読み、面を署名で突き合わせる
gmsh.initialize(); gmsh.option.setNumber('General.Terminal', 0)
gmsh.model.occ.importShapes('plate.step'); gmsh.model.occ.synchronize()
gs = {tag: {'area': gmsh.model.occ.getMass(2, tag), 'c': gmsh.model.occ.getCenterOfMass(2, tag)} for _, tag in gmsh.model.getEntities(2)}
bb = gmsh.model.getBoundingBox(-1, -1); print('Gmsh が読んだ外形 [座標の単位そのまま]:', [round(v, 3) for v in bb])
match = {}
for i, s in enumerate(sig):
    cand = [t for t, g in gs.items() if abs(g['area']-s['area']) <= 1e-6*max(1, s['area']) and dist(g['c'], s['c']) <= 1e-6*L]
    match[i] = cand
print('署名による対応（OCP の面番号 → Gmsh の面タグ）:', match, '| 1対1:', all(len(v) == 1 for v in match.values()))

# ---- 3. 名前付き選択 → 物理グループ → メッシュ
fix = [match[i][0] for i, s in enumerate(sig) if abs(s['c'][0]) < 1e-6]
load = [match[i][0] for i, s in enumerate(sig) if abs(s['c'][0]-L) < 1e-6]
gmsh.model.addPhysicalGroup(2, fix, name='FIX'); gmsh.model.addPhysicalGroup(2, load, name='LOAD')
gmsh.model.addPhysicalGroup(3, [t for _, t in gmsh.model.getEntities(3)], name='SOLID')
size = float(sys.argv[1]) if len(sys.argv) > 1 else 6.0
gmsh.option.setNumber('Mesh.ElementOrder', 2); gmsh.option.setNumber('Mesh.MeshSizeMax', size)
gmsh.option.setNumber('Mesh.MeshSizeMin', size/6); gmsh.option.setNumber('Mesh.MeshSizeFromCurvature', 40)
t0 = time.time(); gmsh.model.mesh.generate(3); t_mesh = time.time()-t0
# メッシュ側の面積（グループごと）を CAD の面積と比べる
def group_area(tags):
    a = 0.0
    for t in tags:
        types, _, nodes = gmsh.model.mesh.getElements(2, t)
        for et, nn in zip(types, nodes):
            n_per = gmsh.model.mesh.getElementProperties(et)[3]
            for k in range(0, len(nn), n_per):
                p = [gmsh.model.mesh.getNode(int(nn[k+j]))[0] for j in range(3)]
                u = [p[1][i]-p[0][i] for i in range(3)]; v = [p[2][i]-p[0][i] for i in range(3)]
                cr = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]); a += 0.5*math.sqrt(sum(c*c for c in cr))
    return a
hole_i = next(i for i, s in enumerate(sig) if 'Cylinder' in s['type'])
print('面積の照合 FIX: CAD', W*T, 'メッシュ', round(group_area(fix), 4), '| 穴の円筒面: CAD', round(sig[hole_i]['area'], 3), 'メッシュ(直線近似)', round(group_area(match[hole_i]), 3))
ntet = sum(len(t) for t in gmsh.model.mesh.getElements(3)[1]); nnode = len(gmsh.model.mesh.getNodes()[0])
gmsh.option.setNumber('Mesh.SaveGroupsOfNodes', 1); gmsh.write('mesh.inp'); gmsh.write('mesh.msh'); gmsh.finalize()
print(f'メッシュ: 四面体 {ntet}、節点 {nnode}、生成 {t_mesh:.1f} s')

# ---- 4. CalculiX の入力（面要素の定義は捨て、体積要素と節点集合だけ使う）
keep, out = True, []
for line in open('mesh.inp'):
    if line.upper().startswith('*ELEMENT'):
        keep = 'C3D10' in line.upper()
    elif line.startswith('*'):
        keep = True
    if keep: out.append(line)
mesh_txt = ''.join(out)
elset = re.search(r'\*ELEMENT[^\n]*C3D10[^\n]*ELSET=(\w+)', mesh_txt, re.I).group(1)
nsets = re.findall(r'\*NSET,\s*NSET=(\w+)', mesh_txt, re.I)
print('inp に出た体積要素集合:', elset, '| 節点集合:', nsets)
disp = 0.1
open('job.inp', 'w').write(mesh_txt + f"""*MATERIAL, NAME=STEEL
*ELASTIC
210000., 0.3
*SOLID SECTION, ELSET={elset}, MATERIAL=STEEL
*STEP
*STATIC
*BOUNDARY
FIX, 1, 3, 0.
LOAD, 1, 1, {disp}
*NODE PRINT, NSET=LOAD, TOTALS=ONLY
RF
*EL PRINT, ELSET={elset}
S
*NODE FILE
U
*EL FILE
S
*END STEP
""")
t0 = time.time()
import resource
r = subprocess.run(['ccx', '-i', 'job'], capture_output=True, text=True, env={**os.environ, 'OMP_NUM_THREADS': '4', 'CCX_NPROC_RESULTS': '1'})
peak_kb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
t_ccx = time.time()-t0
dat = open('job.dat').read()
rf = float(re.search(r'total force \(fx,fy,fz\)[^\n]*\n\s*\n\s*([-\d.E+]+)', dat).group(1))
smax_ip = max(float(l.split()[2]) for l in dat.split('stresses (elem, integ.pnt.')[1].splitlines()[2:] if len(l.split()) == 8)
# frd の節点応力（外挿値）
smax_node, in_s = -1e30, False
for l in open('job.frd'):
    if l.startswith(' -4  STRESS'): in_s = True
    elif l.startswith(' -3'): in_s = False
    elif in_s and l.startswith(' -1'): smax_node = max(smax_node, float(l[13:25]))
sg = rf/(W*T)
kt_ref = (2 + 0.284*0.8 - 0.6*0.8**2 + 1.32*0.8**3)/0.8
print(f'CalculiX: {t_ccx:.1f} s、最大メモリ {peak_kb/1024:.0f} MB、反力 {rf:.1f} N、公称応力 {sg:.3f} MPa')
print(f'応力集中係数（総断面基準）: 積分点 {smax_ip/sg:.3f}、節点 {smax_node/sg:.3f}、文献の近似式 {kt_ref:.3f}（平面応力）')
json.dump({'size': size, 'ntet': ntet, 'nnode': nnode, 'kt_ip': smax_ip/sg, 'kt_node': smax_node/sg, 'peak_mb': peak_kb/1024, 't_ccx': t_ccx}, open(f'result_{size}.json', 'w'))

# ---- 5. 形状を変えたときの面の追跡（穴径 20 → 24、穴を 30 mm 移動）
def rematch(old, new):
    res = []
    for o in old:
        same = [n for n in new if n['type'] == o['type'] and abs(n['area']-o['area']) <= 1e-6*o['area'] and dist(n['c'], o['c']) <= 1e-6*L]
        near = [n for n in new if n['type'] == o['type'] and dist(n['c'], o['c']) <= 0.02*L]
        res.append('同一' if len(same) == 1 else ('変更あり・候補1件' if len(near) == 1 else ('候補が複数' if len(near) > 1 else '見つからない')))
    return res
names = [('円筒' if 'Cyl' in s['type'] else '平面') + f"@({s['c'][0]:.0f},{s['c'][1]:.0f},{s['c'][2]:.0f})" for s in sig]
for label, kw in [('穴径 20→24', dict(d=24.0)), ('穴を x 方向に 30 mm 移動', dict(d=20.0, cx=L/2+30))]:
    new = signatures(make_plate(path='plate2.step', **kw))
    print(label, ':', dict(zip(names, rematch(sig, new))))
