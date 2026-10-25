import Tia.Theorems
namespace Tia

def suite (id : Key) (file : Path) (deps : List Path) (needs : List Key := []) : Item × Group :=
  (⟨id, id, deps, needs, false⟩, ⟨id, file, deps, true, false⟩)

def prob (xs : List (Item × Group)) (changes : List Path) : Problem :=
  { items := xs.map (·.1), groups := xs.map (·.2), known := [], structural := [],
    onUnknown := .full, changes := changes }

/-- Spec says: a changed suite file also selects suites that observe it (TypeScript and Go agree,
the Python SDK does not). -/
example : (prob [suite "A" "test/a.test.ts" [], suite "B" "test/b.test.ts" ["test/a.test.ts"]]
    ["test/a.test.ts"]).select = .only ["A", "B"] ["A"] := by decide

/-- Non-vacuity: an unrelated, known change selects nothing. -/
example : ({ prob [suite "A" "test/a.test.ts" ["src/a.ts"]] ["docs/readme.md"] with
    known := ["docs/readme.md"] } : Problem).select = .only [] [] := by decide

/-- Counterexample to `selected ⊆ catalog` without `WellFormed`: this is the allowed-suites case
(A needs B, but B was filtered out of the catalog). -/
example : (prob [suite "A" "test/a.test.ts" ["src/a.ts"] ["B"]] ["src/a.ts"]).select
    = .only ["A", "B"] [] := by decide

/-- Unknown changes escalate. -/
example : (prob [suite "A" "test/a.test.ts" ["src/a.ts"]] ["src/new.ts"]).select
    = .full "src/new.ts" := by decide

end Tia
