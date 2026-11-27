import Tia.Progress
namespace Tia
open Problem

/-! ## Monotonicity in the change set -/

/-- The obligation first stated in `Theorems.lean`: more changes keep a selective plan
selective and only grow it. It is false: one more change can trip a wire. -/
def MonotoneInChangesAlwaysOnly : Prop :=
  ∀ (p q : Problem), p.items = q.items → p.groups = q.groups → p.known = q.known →
    p.structural = q.structural → p.onUnknown = q.onUnknown → p.changes ⊆ q.changes →
    ∀ is gs, p.select = .only is gs → ∃ is' gs', q.select = .only is' gs' ∧ is ⊆ is' ∧ gs ⊆ gs'

/-- An empty change set selects nothing; adding a change the graph does not know runs
everything under `onUnknown = .full`. -/
theorem not_monotoneInChangesAlwaysOnly : ¬ MonotoneInChangesAlwaysOnly := by
  intro h
  have hp : Problem.select ⟨[], [], [], [], .full, []⟩ = .only [] [] := by decide
  have hq : Problem.select ⟨[], [], [], [], .full, ["unknown"]⟩ = .full "unknown" := by decide
  obtain ⟨_, _, hq', _⟩ :=
    h ⟨[], [], [], [], .full, []⟩ ⟨[], [], [], [], .full, ["unknown"]⟩
      rfl rfl rfl rfl rfl (by simp) [] [] hp
  rw [hq] at hq'
  simp at hq'

/-- Monotonicity in the change set: more changes never shrink a selective plan. They add
items and groups, or escalate to a full run, which only a tripping change causes
(`select_full_trips`). `known`, `structural` and `onUnknown` decide only whether a change
trips, so unlike `MonotoneInChangesAlwaysOnly` they need not agree. -/
def MonotoneInChanges : Prop :=
  ∀ (p q : Problem), p.items = q.items → p.groups = q.groups → p.changes ⊆ q.changes →
    ∀ is gs, p.select = .only is gs →
      (∃ because, q.select = .full because) ∨
        ∃ is' gs', q.select = .only is' gs' ∧ is ⊆ is' ∧ gs ⊆ gs'

theorem step_mono (items : List Item) (s s' : List Key) (h : ∀ k ∈ s, k ∈ s') :
    ∀ k ∈ step items s, k ∈ step items s' := by
  intro k hk
  rcases (mem_step items s k).1 hk with hk | ⟨it, hit, hs, hn⟩
  · exact (mem_step items s' k).2 (Or.inl (h k hk))
  · exact (mem_step items s' k).2 (Or.inr ⟨it, hit, h _ hs, hn⟩)

theorem close_mono (items : List Item) :
    ∀ (n : Nat) (s s' : List Key), (∀ k ∈ s, k ∈ s') → ∀ k ∈ close items n s, k ∈ close items n s'
  | 0, _, _, h => h
  | n + 1, s, s', h => close_mono items n _ _ (step_mono items s s' h)

theorem wholeHit_mono (p q : Problem) (hi : p.items = q.items) (hc : p.changes ⊆ q.changes)
    (g : Group) (h : WholeHit p g) : WholeHit q g := by
  rcases h with h | ⟨c, hcm, h⟩
  · exact Or.inl h
  · exact Or.inr ⟨c, hc hcm, hi ▸ h⟩

theorem affected_mono (p q : Problem) (hi : p.items = q.items) (hg : p.groups = q.groups)
    (hc : p.changes ⊆ q.changes) (it : Item) (h : Affected p it) : Affected q it := by
  rcases h with h | ⟨c, hcm, hd⟩ | ⟨g, hgm, hk, hw⟩
  · exact Or.inl h
  · exact Or.inr (Or.inl ⟨c, hc hcm, hd⟩)
  · exact Or.inr (Or.inr ⟨g, hg ▸ hgm, hk, wholeHit_mono p q hi hc g hw⟩)

theorem select_only_groups (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    gs = (p.groups.filter p.wholeGroup).map (·.key) := by
  unfold Problem.select at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp only [Selection.only.injEq] at h
      exact h.2.symm

theorem monotone_in_changes : MonotoneInChanges := by
  intro p q hi hg hc is gs hp
  cases hq : q.select with
  | full because => exact Or.inl ⟨because, rfl⟩
  | only is' gs' =>
    refine Or.inr ⟨is', gs', rfl, ?_, ?_⟩
    · intro k hk
      obtain ⟨hsp, _⟩ := closure_spec _ _ _ (select_only_cases p is gs hp).2
      obtain ⟨hsq, _⟩ := closure_spec _ _ _ (select_only_cases q is' gs' hq).2
      rw [hsp] at hk
      rw [hsq, ← hi]
      refine close_mono p.items _ _ _ ?_ k hk
      intro k' hk'
      obtain ⟨it, hit, rfl⟩ := List.mem_map.1 hk'
      obtain ⟨hmem, haff⟩ := List.mem_filter.1 hit
      have hq' : q.affected it = true :=
        (affected_iff q it).2 (affected_mono p q hi hg hc it ((affected_iff p it).1 haff))
      exact List.mem_map.2 ⟨it, List.mem_filter.2 ⟨hmem, hq'⟩, rfl⟩
    · intro k hk
      rw [select_only_groups p is gs hp] at hk
      rw [select_only_groups q is' gs' hq]
      obtain ⟨g, hgm, rfl⟩ := List.mem_map.1 hk
      obtain ⟨hmem, hw⟩ := List.mem_filter.1 hgm
      have hmem' : g ∈ q.groups := hg ▸ hmem
      have hw' : q.wholeGroup g = true :=
        (wholeGroup_iff q g).2 (wholeHit_mono p q hi hc g ((wholeGroup_iff p g).1 hw))
      exact List.mem_map.2 ⟨g, List.mem_filter.2 ⟨hmem', hw'⟩, rfl⟩

/-- With `progress`, a full run has exactly one cause: a change that trips a wire. -/
theorem select_full_trips (p : Problem) (because : Path) (h : p.select = .full because) :
    because ∈ p.changes ∧ p.trips because = true := by
  unfold Problem.select at h
  split at h
  · rename_i c hf
    simp only [Selection.full.injEq] at h
    subst h
    exact ⟨List.mem_of_find?_eq_some hf, List.find?_some hf⟩
  · obtain ⟨s, hs⟩ := Option.isSome_iff_exists.1 (progress p ((p.items.filter p.affected).map (·.id)))
    rw [hs] at h
    simp at h

end Tia
