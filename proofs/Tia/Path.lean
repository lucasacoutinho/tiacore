namespace Tia

/-- Segment-level model of protocol path normalization (string split/join is the shell's job). -/
def normSegs (xs : List String) : List String := xs.filter fun s => s != "" && s != "."

/-- `none` rejects: empty result or a parent escape. -/
def normalize (xs : List String) : Option (List String) :=
  let ys := normSegs xs
  if ys.isEmpty || ys.any (· == "..") then none else some ys

theorem normSegs_idem (xs : List String) : normSegs (normSegs xs) = normSegs xs := by
  unfold normSegs
  rw [List.filter_filter]
  apply List.filter_congr
  intro s _
  simp

theorem normalize_eq_some (xs ys : List String) :
    normalize xs = some ys ↔
      ys = normSegs xs ∧ (normSegs xs).isEmpty = false ∧ (normSegs xs).any (· == "..") = false := by
  unfold normalize
  by_cases h : ((normSegs xs).isEmpty || (normSegs xs).any (· == "..")) = true
  · simp only [h, if_true]
    simp only [Bool.or_eq_true] at h
    constructor
    · intro e; exact absurd e (by simp)
    · rintro ⟨_, h1, h2⟩; rcases h with h | h <;> simp_all
  · simp only [h, Bool.false_eq_true, if_false, Option.some.injEq]
    simp only [Bool.or_eq_true, not_or, Bool.not_eq_true] at h
    constructor
    · intro e; exact ⟨e.symm, h.1, h.2⟩
    · rintro ⟨e, _, _⟩; exact e.symm

theorem normalize_clean (xs ys : List String) (h : normalize xs = some ys) :
    ∀ s ∈ ys, s ≠ "" ∧ s ≠ "." ∧ s ≠ ".." := by
  obtain ⟨rfl, _, h2⟩ := (normalize_eq_some xs ys).1 h
  intro s hs
  have h3 := (List.mem_filter.1 hs).2
  have h4 := List.any_eq_false.1 h2 s hs
  simp at h3 h4
  exact ⟨h3.1, h3.2, h4⟩

theorem normalize_idem (xs ys : List String) (h : normalize xs = some ys) :
    normalize ys = some ys := by
  have hc := normalize_clean xs ys h
  obtain ⟨hy, hne, _⟩ := (normalize_eq_some xs ys).1 h
  rw [normalize_eq_some]
  have e : normSegs ys = ys := by rw [hy]; exact normSegs_idem xs
  refine ⟨e.symm, ?_, ?_⟩
  · rw [e, hy]; exact hne
  · rw [e]
    simp only [List.any_eq_false]
    intro s hs; have := (hc s hs).2.2; simp [this]

end Tia
