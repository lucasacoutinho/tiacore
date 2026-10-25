import Lean
import Tia
open Lean

def allowedAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

def main : IO UInt32 := do
  initSearchPath (← findSysroot)
  let env ← importModules #[{ module := `Tia }] {}
  let theorems := env.constants.toList.filterMap fun (name, info) =>
    match info with
    | .thmInfo _ => if (`Tia).isPrefixOf name && !name.isInternal then some name else none
    | _ => none
  let mut failures := 0
  for name in theorems do
    let (axioms, _) ← (collectAxioms name : CoreM (Array Name)).toIO
      { fileName := "<axioms>", fileMap := default } { env }
    let extra := axioms.toList.filter (!allowedAxioms.contains ·)
    unless extra.isEmpty do
      IO.eprintln s!"{name} depends on {extra}"
      failures := failures + 1
  IO.println s!"checked {theorems.length} theorems; {failures} use axioms outside {allowedAxioms}"
  return if failures == 0 && theorems.length > 0 then 0 else 1
