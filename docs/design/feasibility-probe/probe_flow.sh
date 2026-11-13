#!/usr/bin/env bash
# 使い捨ての実現性確認（流れ側）: Gmsh で名前を付けた面が、OpenFOAM のパッチ名として引き継がれるかを確かめる。
# 前提: python に gmsh が入っていること。gmshToFoam と checkMesh が PATH にあること（OpenFOAM v1912 で確認）。
set -euo pipefail
work="${1:-./foam-probe}"
mkdir -p "$work/system" "$work/constant"
cd "$work"
python - <<'PY'
import gmsh
gmsh.initialize(); gmsh.option.setNumber('General.Terminal', 0)
gmsh.model.occ.addBox(0, 0, 0, 0.2, 0.02, 0.02); gmsh.model.occ.synchronize()
inlet, outlet, walls = [], [], []
for _, t in gmsh.model.getEntities(2):
    x = gmsh.model.occ.getCenterOfMass(2, t)[0]
    (inlet if abs(x) < 1e-9 else outlet if abs(x - 0.2) < 1e-9 else walls).append(t)
gmsh.model.addPhysicalGroup(2, inlet, name='inlet')
gmsh.model.addPhysicalGroup(2, outlet, name='outlet')
gmsh.model.addPhysicalGroup(2, walls, name='walls')
gmsh.model.addPhysicalGroup(3, [1], name='fluid')
gmsh.option.setNumber('Mesh.MeshSizeMax', 0.003); gmsh.model.mesh.generate(3)
gmsh.option.setNumber('Mesh.MshFileVersion', 2.2); gmsh.write('duct.msh'); gmsh.finalize()
PY
cat > system/controlDict <<'DICT'
FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application simpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1; writeControl timeStep; writeInterval 1;
DICT
printf 'FoamFile { version 2.0; format ascii; class dictionary; object fvSchemes; }\nddtSchemes{default steadyState;}\ngradSchemes{default Gauss linear;}\ndivSchemes{default none;}\nlaplacianSchemes{default Gauss linear corrected;}\ninterpolationSchemes{default linear;}\nsnGradSchemes{default corrected;}\n' > system/fvSchemes
printf 'FoamFile { version 2.0; format ascii; class dictionary; object fvSolution; }\nsolvers{}\n' > system/fvSolution
# Debian の OpenFOAM v1912 は、この変数がないとどのコマンドも失敗する
export WM_PROJECT_DIR="${WM_PROJECT_DIR:-/usr/share/openfoam}"
gmshToFoam duct.msh > log.gmshToFoam 2>&1
grep -E "^\s+(inlet|outlet|walls)$|nFaces" constant/polyMesh/boundary
checkMesh > log.checkMesh 2>&1
grep -E "cells:|non-orthogonality Max|Max skewness|Mesh OK|Failed" log.checkMesh
