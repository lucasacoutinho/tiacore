import Tia.Check
import Tia.Model
namespace Tia

inductive Issue
  | selectionMiss | incompleteGraph | outcomeMismatch | dependencyMismatch | coverageMismatch
  deriving DecidableEq, Repr

/-- Everything `verify` compares, reduced to what the verdict depends on. -/
structure Compare where
  expected      : List Key      -- tests the change obliges (derived from the union of both graphs)
  executed      : List Key      -- tests the selective phase ran
  selComplete : Bool
  fullComplete : Bool
  outcomesEq : Bool
  depsEq : Bool
  coverageChecked : Bool
  coverageEq : Bool

def Compare.missed (c : Compare) : List Key := c.expected.filter (!c.executed.contains ·)

def Compare.guards (c : Compare) : List (Bool × Issue) :=
  [ (c.missed.isEmpty, .selectionMiss), (c.selComplete, .incompleteGraph),
    (c.fullComplete, .incompleteGraph), (c.outcomesEq, .outcomeMismatch),
    (c.depsEq, .dependencyMismatch), (!c.coverageChecked || c.coverageEq, .coverageMismatch) ]

def Compare.issues (c : Compare) : List Issue := allFails c.guards
def Compare.verified (c : Compare) : Bool := c.issues.isEmpty

theorem missed_iff (c : Compare) : c.missed = [] ↔ ∀ e ∈ c.expected, e ∈ c.executed := by
  simp [Compare.missed, List.filter_eq_nil_iff]

/-- Verified exactly when every comparison holds: no silent pass. -/
theorem verified_iff (c : Compare) : c.verified = true ↔
    (∀ e ∈ c.expected, e ∈ c.executed) ∧ c.selComplete = true ∧ c.fullComplete = true ∧
    c.outcomesEq = true ∧ c.depsEq = true ∧ (c.coverageChecked = true → c.coverageEq = true) := by
  unfold Compare.verified Compare.issues
  have hm := missed_iff c
  rw [List.isEmpty_iff, allFails_nil_iff]
  simp only [Compare.guards, List.mem_cons, List.not_mem_nil, or_false, forall_eq_or_imp,
    forall_eq, List.isEmpty_iff, hm]
  constructor
  · rintro ⟨h1, h2, h3, h4, h5, h6⟩
    exact ⟨h1, h2, h3, h4, h5, fun hc => by simpa [hc] using h6⟩
  · rintro ⟨h1, h2, h3, h4, h5, h6⟩
    refine ⟨h1, h2, h3, h4, h5, ?_⟩
    cases hc : c.coverageChecked
    · simp
    · simp [h6 hc]

/-- A missed required test always fails verification. -/
theorem miss_fails (c : Compare) (e : Key) (he : e ∈ c.expected) (hn : e ∉ c.executed) :
    c.verified = false := by
  cases hv : c.verified
  · rfl
  · exact absurd ((verified_iff c).1 hv).1 (fun h => hn (h e he))

def cleanCompare : Compare where
  expected := ["a"]
  executed := ["a", "b"]
  selComplete := true
  fullComplete := true
  outcomesEq := true
  depsEq := true
  coverageChecked := false
  coverageEq := false

/-- Anti-vacuity: a clean comparison verifies. -/
example : cleanCompare.verified = true := by decide

end Tia
