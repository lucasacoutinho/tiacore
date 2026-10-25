namespace Tia

/-- An ordered list of guards. The first failing guard names the reason, as the shells report it. -/
def firstFail {α : Type} : List (Bool × α) → Option α
  | [] => none
  | (ok, r) :: cs => if ok then firstFail cs else some r

theorem firstFail_none_iff {α : Type} (cs : List (Bool × α)) :
    firstFail cs = none ↔ ∀ c ∈ cs, c.1 = true := by
  induction cs with
  | nil => simp [firstFail]
  | cons c cs ih =>
    obtain ⟨ok, r⟩ := c
    cases ok <;> simp [firstFail, ih]

theorem firstFail_some {α : Type} (cs : List (Bool × α)) (r : α) (h : firstFail cs = some r) :
    ∃ c ∈ cs, c.1 = false ∧ c.2 = r := by
  induction cs with
  | nil => simp [firstFail] at h
  | cons c cs ih =>
    obtain ⟨ok, r'⟩ := c
    cases ok with
    | true =>
      simp only [firstFail, if_true] at h
      obtain ⟨c, hc, h1, h2⟩ := ih h
      exact ⟨c, List.mem_cons_of_mem _ hc, h1, h2⟩
    | false =>
      simp only [firstFail, Bool.false_eq_true, if_false, Option.some.injEq] at h
      exact ⟨(false, r'), List.mem_cons_self, rfl, h⟩

/-- Every failing guard is reported by the all-issues variant used by `verify`. -/
def allFails {α : Type} (cs : List (Bool × α)) : List α :=
  cs.filterMap fun c => if c.1 then none else some c.2

theorem allFails_nil_iff {α : Type} (cs : List (Bool × α)) :
    allFails cs = [] ↔ ∀ c ∈ cs, c.1 = true := by
  induction cs with
  | nil => simp [allFails]
  | cons c cs ih =>
    obtain ⟨ok, r⟩ := c
    cases ok <;> simp_all [allFails]

end Tia
