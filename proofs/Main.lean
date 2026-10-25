import Tia
open Lean Tia

def main : IO Unit := do
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= fromJson? (α := Problem) with
  | .error e => IO.eprintln e; IO.Process.exit 2
  | .ok p => IO.println (toJson p.select).compress
