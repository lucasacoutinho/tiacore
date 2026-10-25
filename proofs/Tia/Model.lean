import Lean.Data.Json
open Lean

namespace Tia

abbrev Path := String
abbrev Key := String

/-- A unit of selection: a suite (protocol) or a test case (runtime). -/
structure Item where
  id    : Key
  group : Key          -- own id for a suite; test-file key for a test case
  deps  : List Path    -- precise recorded dependencies
  needs : List Key     -- dependsOn; [] for test cases
  rerun : Bool         -- previous failure that still exists
  deriving ToJson, FromJson

/-- Coarse evidence: the file that selects the whole group, and module-level deps. -/
structure Group where
  key    : Key
  file   : Path
  coarse : List Path
  exact  : Bool        -- false: per-test edges are incomplete for this file
  rerun  : Bool        -- whole-group failure (module-level or inexact)
  deriving ToJson, FromJson

inductive OnUnknown | full | ignore
  deriving DecidableEq, ToJson, FromJson

/-- Everything the shell must supply: values only, no I/O. Glob matching is done
by the caller: `structural` lists changed paths that tripped an invalidator. -/
structure Problem where
  items      : List Item
  groups     : List Group
  known      : List Path     -- knownSources, ignored paths, dead-group deps
  structural : List Path
  onUnknown  : OnUnknown
  changes    : List Path     -- normalized, sorted, ignores already removed
  deriving ToJson, FromJson

inductive Selection
  | full (because : Path)
  | only (items groups : List Key)
  deriving ToJson, FromJson, Repr, DecidableEq

namespace Problem

def itemsIn (p : Problem) (k : Key) : List Item := p.items.filter (·.group == k)

def residue (p : Problem) (g : Group) (c : Path) : Bool :=
  g.coarse.contains c && (!g.exact || !(p.itemsIn g.key).any (·.deps.contains c))

def hits (p : Problem) (g : Group) (c : Path) : Bool := g.file == c || p.residue g c

def wholeGroup (p : Problem) (g : Group) : Bool := g.rerun || p.changes.any (p.hits g)

def affected (p : Problem) (it : Item) : Bool :=
  it.rerun || p.changes.any it.deps.contains ||
    p.groups.any fun g => g.key == it.group && p.wholeGroup g

def isKnown (p : Problem) (c : Path) : Bool :=
  p.known.contains c || p.items.any (·.deps.contains c) ||
    p.groups.any fun g => g.file == c || g.coarse.contains c

def trips (p : Problem) (c : Path) : Bool :=
  p.structural.contains c || (p.onUnknown == .full && !p.isKnown c)

def step (items : List Item) (s : List Key) : List Key :=
  s ++ ((items.filter (s.contains ·.id)).flatMap (·.needs)).filter (!s.contains ·)

def close (items : List Item) : Nat → List Key → List Key
  | 0, s => s
  | n + 1, s => close items n (step items s)

def closedB (items : List Item) (s : List Key) : Bool :=
  items.all fun it => !s.contains it.id || it.needs.all s.contains

/-- `none` = did not converge within fuel; the caller must then run everything. -/
def closure (p : Problem) (seed : List Key) : Option (List Key) :=
  let s := close p.items (p.items.length + 2) seed
  if closedB p.items s then some s else none

def select (p : Problem) : Selection :=
  match p.changes.find? p.trips with
  | some c => .full c
  | none =>
    match p.closure ((p.items.filter p.affected).map (·.id)) with
    | none => .full "<closure did not converge>"
    | some s => .only s ((p.groups.filter p.wholeGroup).map (·.key))

end Problem
end Tia
