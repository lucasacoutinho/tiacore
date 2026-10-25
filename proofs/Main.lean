import Tia
open Lean Tia

/-- Reads a JSON array of problems on stdin and prints the array of selections. -/
def main : IO UInt32 := do
  let input ← (← IO.getStdin).readToEnd
  match Json.parse input >>= fromJson? (α := Array Problem) with
  | .error e => IO.eprintln e; return 2
  | .ok problems =>
    IO.println (toJson (problems.map (·.select))).compress
    return 0
