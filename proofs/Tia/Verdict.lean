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

/-! ## Suite outcomes

A suite-granular runner (k6, Maestro, Gradle, the Python and Go SDKs) keeps no cache of
results, so a suite its selective phase did not run has no outcome of its own. Its graph is
only promoted after every suite passed, so the suite stands for what the baseline recorded:
it passed. The full phase shows whether that still holds. -/

inductive Result
  | passed | failed | unknown
  deriving DecidableEq, Repr

/-- One phase of a suite-granular run as far as outcomes go: the suites its plan covered, the
suites it ran, and how each of those ended. -/
structure SuitePhase where
  scope    : List Key
  executed : List Key
  outcome  : Key → Option Result

/-- What the phase says about a suite: an executed suite's own outcome (`unknown` when the run
recorded none), a covered suite's carried-over pass, and nothing for a suite outside the plan. -/
def SuitePhase.effective (p : SuitePhase) (k : Key) : Option Result :=
  if p.executed.contains k then some ((p.outcome k).getD .unknown)
  else if p.scope.contains k then some .passed
  else none

/-- Every suite either phase mentions. -/
def mentioned (s f : SuitePhase) : List Key := s.scope ++ s.executed ++ f.scope ++ f.executed

/-- The phases agree on a suite when both say the same, and what they say is not `unknown`. -/
def Agree (s f : SuitePhase) (k : Key) : Bool :=
  match s.effective k, f.effective k with
  | some a, some b => a == b && a != .unknown
  | _, _ => false

def outcomesEq (s f : SuitePhase) : Bool := (mentioned s f).all (Agree s f)

theorem agree_iff (s f : SuitePhase) (k : Key) : Agree s f k = true ↔
    ∃ r, r ≠ .unknown ∧ s.effective k = some r ∧ f.effective k = some r := by
  unfold Agree
  cases hs : s.effective k with
  | none => simp
  | some a =>
    cases hf : f.effective k with
    | none => simp
    | some b =>
      constructor
      · intro h
        simp only [Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq] at h
        exact ⟨a, h.2, rfl, by rw [← h.1]⟩
      · rintro ⟨r, hr, h1, h2⟩
        cases h1
        cases h2
        simp [hr]

/-- The outcomes agree exactly when every suite either phase mentions has the same known outcome
in both. -/
theorem outcomesEq_iff (s f : SuitePhase) : outcomesEq s f = true ↔
    ∀ k ∈ mentioned s f, ∃ r, r ≠ .unknown ∧ s.effective k = some r ∧ f.effective k = some r := by
  unfold outcomesEq
  rw [List.all_eq_true]
  exact forall_congr' fun k => imp_congr_right fun _ => agree_iff s f k

/-- A suite the plan did not run stands for the baseline: it passed when the plan covered it. -/
theorem effective_unrun (p : SuitePhase) (k : Key) (hn : k ∉ p.executed) :
    p.effective k = if p.scope.contains k then some .passed else none := by
  rw [SuitePhase.effective, if_neg (by simpa using hn)]

/-- A suite the selective phase did not run is carried as passed, so it cannot hide a failure:
a suite that fails in the full phase makes the outcomes differ. -/
theorem unselected_failure_detected (s f : SuitePhase) (k : Key) (hk : k ∈ mentioned s f)
    (hn : k ∉ s.executed) (hf : f.effective k = some .failed) : outcomesEq s f = false := by
  cases h : outcomesEq s f
  · rfl
  · obtain ⟨r, _, h1, h2⟩ := (outcomesEq_iff s f).1 h k hk
    rw [effective_unrun s k hn] at h1
    rw [hf] at h2
    split at h1
    · cases h1
      cases h2
    · cases h1

/-- An outcome the run could not attribute never agrees, not even with itself. -/
theorem unknown_never_agrees (s f : SuitePhase) (k : Key) (hk : k ∈ mentioned s f)
    (hu : s.effective k = some .unknown) : outcomesEq s f = false := by
  cases h : outcomesEq s f
  · rfl
  · obtain ⟨r, hr, h1, _⟩ := (outcomesEq_iff s f).1 h k hk
    rw [hu] at h1
    exact absurd (Option.some.inj h1).symm hr

/-- A verified comparison whose outcome guard is the one above leaves no unrun suite unaccounted
for: each is covered by the selective plan and passes in the full phase. -/
theorem verified_unselected_passes (s f : SuitePhase) (c : Compare)
    (hc : c.outcomesEq = outcomesEq s f) (hv : c.verified = true)
    (k : Key) (hk : k ∈ mentioned s f) (hn : k ∉ s.executed) :
    s.scope.contains k = true ∧ f.effective k = some .passed := by
  have h := ((verified_iff c).1 hv).2.2.2.1
  rw [hc] at h
  obtain ⟨r, hr, h1, h2⟩ := (outcomesEq_iff s f).1 h k hk
  rw [effective_unrun s k hn] at h1
  split at h1
  · cases h1
    exact ⟨by assumption, h2⟩
  · cases h1

def cleanPhase : SuitePhase where
  scope := ["a", "b"]
  executed := ["a"]
  outcome := fun _ => some .passed

/-- Anti-vacuity: a selective phase that ran one suite agrees with a full phase that ran both. -/
example : outcomesEq cleanPhase { cleanPhase with executed := ["a", "b"] } = true := by decide

/-- Anti-vacuity: the unrun suite failing in the full phase is caught. -/
example : outcomesEq cleanPhase
    { cleanPhase with executed := ["a", "b"],
                      outcome := fun k => if k == "b" then some .failed else some .passed }
    = false := by decide

/-- Anti-vacuity: an outcome the run could not attribute does not verify. -/
example : outcomesEq { cleanPhase with outcome := fun _ => none }
    { cleanPhase with executed := ["a", "b"] } = false := by decide

end Tia
