"""Dienstrooster Solver Package"""

# solver/Dockerfile COPYs this directory's contents directly into a bare
# WORKDIR, so in production solver.py/constraints.py/objective.py are flat
# sibling modules (main.py's `from solver import RosterSolver` resolves
# `solver` to solver.py itself, and this __init__.py is never even loaded).
# solver.py's own `from constraints import ConstraintBuilder` relies on
# exactly that flat layout. Importing this file as a real package - the
# only way anything outside main.py's Docker context reaches it, including
# every pytest run - needs the same flat layout on sys.path first, or
# solver.py's import fails with `ModuleNotFoundError: No module named
# 'constraints'` depending on which directory the import was launched from.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from .solver import RosterSolver
from .constraints import ConstraintBuilder
from .objective import ObjectiveBuilder

__all__ = ['RosterSolver', 'ConstraintBuilder', 'ObjectiveBuilder']
