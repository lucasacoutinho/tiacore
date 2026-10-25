import Tia.Model
namespace Tia
open Problem

/-! ## Contract, stated without reference to the algorithm -/

/-- Why a group is selected as a whole. -/
def WholeHit (p : Problem) (g : Group) : Prop :=
  g.rerun = true ∨
  ∃ c ∈ p.changes, g.file = c ∨
    (c ∈ g.coarse ∧ (g.exact = false ∨ ∀ it ∈ p.items, it.group = g.key → c ∉ it.deps))

/-- An item the change set (or a prior failure) obliges us to run. -/
def Affected (p : Problem) (it : Item) : Prop :=
  it.rerun = true ∨ (∃ c ∈ p.changes, c ∈ it.deps) ∨
  ∃ g ∈ p.groups, g.key = it.group ∧ WholeHit p g

/-- Selected because affected, or required (transitively) by something selected. -/
inductive Needed (p : Problem) : Key → Prop
  | base (it : Item) : it ∈ p.items → Affected p it → Needed p it.id
  | dep (it : Item) (k : Key) : it ∈ p.items → Needed p it.id → k ∈ it.needs → Needed p k

/-! ## Bridge lemmas between the Boolean algorithm and the contract -/

theorem none_in_group_iff (p : Problem) (k : Key) (c : Path) :
    ((p.items.filter (·.group == k)).any (·.deps.contains c)) = false ↔
      ∀ it ∈ p.items, it.group = k → c ∉ it.deps := by
  rw [← Bool.not_eq_true]
  simp only [List.any_eq_true, List.mem_filter, List.contains_iff_mem, beq_iff_eq]
  constructor
  · intro h it hit hg hc
    exact h ⟨it, ⟨hit, hg⟩, hc⟩
  · rintro h ⟨it, ⟨hit, hg⟩, hc⟩
    exact h it hit hg hc

theorem affected_iff (p : Problem) (it : Item) : p.affected it = true ↔ Affected p it := by
  simp only [Problem.affected, Problem.wholeGroup, Problem.hits, Problem.residue,
    Problem.itemsIn, Affected, WholeHit, Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true',
    List.any_eq_true, List.contains_iff_mem, beq_iff_eq, none_in_group_iff, or_assoc]
  done


theorem wholeGroup_iff (p : Problem) (g : Group) : p.wholeGroup g = true ↔ WholeHit p g := by
  simp only [Problem.wholeGroup, Problem.hits, Problem.residue, Problem.itemsIn, WholeHit,
    Bool.or_eq_true, Bool.and_eq_true, Bool.not_eq_true', List.any_eq_true,
    List.contains_iff_mem, beq_iff_eq, none_in_group_iff]

/-! ## Closure lemmas -/

theorem mem_close_of_mem (items : List Item) :
    ∀ (n : Nat) (s : List Key) (k : Key), k ∈ s → k ∈ close items n s
  | 0, _, _, h => h
  | n + 1, _, k, h => mem_close_of_mem items n _ k (List.mem_append_left _ h)

theorem step_justified (p : Problem) (s : List Key) (h : ∀ k ∈ s, Needed p k) :
    ∀ k ∈ step p.items s, Needed p k := by
  intro k hk
  simp only [step, List.mem_append, List.mem_filter, List.mem_flatMap,
    List.contains_iff_mem] at hk
  rcases hk with hk | ⟨⟨it, ⟨hit, hs⟩, hk⟩, _⟩
  · exact h k hk
  · exact Needed.dep it k hit (h it.id hs) hk

theorem close_justified (p : Problem) :
    ∀ (n : Nat) (s : List Key), (∀ k ∈ s, Needed p k) → ∀ k ∈ close p.items n s, Needed p k
  | 0, _, h => h
  | n + 1, s, h => close_justified p n _ (step_justified p s h)

theorem closedB_spec (items : List Item) (s : List Key) (h : closedB items s = true) :
    ∀ it ∈ items, it.id ∈ s → ∀ k ∈ it.needs, k ∈ s := by
  intro it hit hs k hk
  simp only [closedB, List.all_eq_true, Bool.or_eq_true, Bool.not_eq_true',
    List.contains_iff_mem] at h
  rcases h it hit with h | h
  · exact absurd hs (by simpa using h)
  · exact h k hk

/-! ## What `select` returns when it does not run everything -/

theorem select_only_cases (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    p.changes.find? p.trips = none ∧
    p.closure ((p.items.filter p.affected).map (·.id)) = some is := by
  unfold Problem.select at h
  split at h
  · simp at h
  · rename_i hf
    refine ⟨hf, ?_⟩
    split at h
    · simp at h
    · rename_i s hs
      simp only [Selection.only.injEq] at h
      rw [hs, h.1]

theorem closure_spec (p : Problem) (seed s : List Key) (h : p.closure seed = some s) :
    s = close p.items (p.items.length + 2) seed ∧ closedB p.items s = true := by
  unfold Problem.closure at h
  by_cases hc : closedB p.items (close p.items (p.items.length + 2) seed) = true
  · simp only [hc, if_true, Option.some.injEq] at h
    subst h
    exact ⟨rfl, hc⟩
  · simp only [hc] at h
    exact absurd h (by simp)

/-! ## Obligations -/

/-- Soundness: everything the contract says is affected is selected. In particular every
item whose recorded dependencies meet the change set, and every previous failure. -/
theorem sound (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    ∀ it ∈ p.items, Affected p it → it.id ∈ is := by
  intro it hit haff
  obtain ⟨_, hc⟩ := select_only_cases p is gs h
  obtain ⟨hs, _⟩ := closure_spec _ _ _ hc
  rw [hs]
  apply mem_close_of_mem
  apply List.mem_map.2
  exact ⟨it, List.mem_filter.2 ⟨hit, (affected_iff p it).2 haff⟩, rfl⟩

theorem sound_deps (p : Problem) (is gs : List Key) (h : p.select = .only is gs)
    (it : Item) (hit : it ∈ p.items) (c : Path) (hc : c ∈ p.changes) (hd : c ∈ it.deps) :
    it.id ∈ is :=
  sound p is gs h it hit (Or.inr (Or.inl ⟨c, hc, hd⟩))

theorem sound_rerun (p : Problem) (is gs : List Key) (h : p.select = .only is gs)
    (it : Item) (hit : it ∈ p.items) (hr : it.rerun = true) : it.id ∈ is :=
  sound p is gs h it hit (Or.inl hr)

/-- Dependency closure: a selected item's `needs` are selected. -/
theorem closed (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    ∀ it ∈ p.items, it.id ∈ is → ∀ k ∈ it.needs, k ∈ is := by
  obtain ⟨_, hc⟩ := select_only_cases p is gs h
  obtain ⟨_, hb⟩ := closure_spec _ _ _ hc
  exact closedB_spec _ _ hb

/-- Justification (precision): nothing is selected without a contractual reason. This is
what stops the constant function `select = everything` from satisfying `sound`. -/
theorem justified (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    ∀ k ∈ is, Needed p k := by
  obtain ⟨_, hc⟩ := select_only_cases p is gs h
  obtain ⟨hs, _⟩ := closure_spec _ _ _ hc
  rw [hs]
  apply close_justified
  intro k hk
  obtain ⟨it, hit, rfl⟩ := List.mem_map.1 hk
  obtain ⟨hmem, haff⟩ := List.mem_filter.1 hit
  exact Needed.base it hmem ((affected_iff p it).1 haff)

/-- Whole-group selection is reported for every group the contract names. -/
theorem sound_groups (p : Problem) (is gs : List Key) (h : p.select = .only is gs) :
    ∀ g ∈ p.groups, WholeHit p g → g.key ∈ gs := by
  intro g hg hw
  unfold Problem.select at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp only [Selection.only.injEq] at h
      rw [← h.2]
      exact List.mem_map.2 ⟨g, List.mem_filter.2 ⟨hg, (wholeGroup_iff p g).2 hw⟩, rfl⟩

/-- Premise under which selection stays inside the catalog (protocol `suiteMap` enforces it
before the allowed-suites filter; the shipped TypeScript applies the filter afterwards). -/
def WellFormed (p : Problem) : Prop :=
  ∀ it ∈ p.items, ∀ k ∈ it.needs, ∃ it' ∈ p.items, it'.id = k

theorem selected_in_catalog (p : Problem) (hw : WellFormed p) (is gs : List Key)
    (h : p.select = .only is gs) : ∀ k ∈ is, ∃ it ∈ p.items, it.id = k := by
  intro k hk
  have hn := justified p is gs h k hk
  induction hn with
  | base it hit _ => exact ⟨it, hit, rfl⟩
  | dep it k hit _ hk' _ => exact hw it hit k hk'

/-- Fail-safe: any trip wire anywhere in the change set yields a full run. -/
theorem failsafe (p : Problem) (c : Path) (hc : c ∈ p.changes) (ht : p.trips c = true) :
    ∃ because, p.select = .full because := by
  unfold Problem.select
  cases hf : p.changes.find? p.trips with
  | some b => exact ⟨b, rfl⟩
  | none =>
    have := List.find?_eq_none.1 hf c hc
    exact absurd ht (by simpa using this)

theorem failsafe_structural (p : Problem) (c : Path) (hc : c ∈ p.changes)
    (hs : c ∈ p.structural) : ∃ because, p.select = .full because :=
  failsafe p c hc (by simp [Problem.trips, hs])

theorem failsafe_unknown (p : Problem) (c : Path) (hc : c ∈ p.changes)
    (hu : p.onUnknown = .full) (hk : p.isKnown c = false) :
    ∃ because, p.select = .full because :=
  failsafe p c hc (by simp [Problem.trips, hu, hk])

/-! ## Gate: when the shell may call `select` at all -/

structure Evidence where
  complete    : Bool
  fingerprint : String
  environment : String

structure Admission where
  forceFull        : Bool
  baseline         : Option Evidence      -- none: absent, unparsable, or invalid graph
  current          : String × String      -- (fingerprint, environment) now
  changesAvailable : Bool                 -- the change source did not report "unavailable"
  problem          : Problem

def Admission.trusted (a : Admission) : Bool :=
  !a.forceFull && a.changesAvailable &&
    match a.baseline with
    | none => false
    | some e => e.complete && e.fingerprint == a.current.1 && e.environment == a.current.2

def plan (a : Admission) : Selection :=
  if a.trusted then a.problem.select else .full "uncertain"

theorem trusted_iff (a : Admission) : a.trusted = true ↔
    a.forceFull = false ∧ a.changesAvailable = true ∧
      ∃ e, a.baseline = some e ∧ e.complete = true ∧
        e.fingerprint = a.current.1 ∧ e.environment = a.current.2 := by
  unfold Admission.trusted
  cases hb : a.baseline with
  | none => simp
  | some e =>
    simp only [Bool.and_eq_true, Bool.not_eq_true', beq_iff_eq, Option.some.injEq]
    constructor
    · intro h
      exact ⟨h.1.1, h.1.2, e, rfl, h.2.1.1, h.2.1.2, h.2.2⟩
    · rintro ⟨h1, h2, e', he, h3, h4, h5⟩
      cases he
      exact ⟨⟨h1, h2⟩, ⟨h3, h4⟩, h5⟩

/-- Uncertainty implies a full run, for every way of being uncertain. -/
theorem uncertain_is_full (a : Admission) (h : a.trusted = false) :
    ∃ because, plan a = .full because := by
  unfold plan; simp [h]

theorem certain_is_select (a : Admission) (h : a.trusted = true) :
    plan a = a.problem.select := by
  unfold plan; simp [h]

/-! ## Pending obligations (stated, not proved) -/

/-- Progress: the fuelled closure always converges, so `none` never occurs. -/
def Progress : Prop :=
  ∀ (p : Problem) (seed : List Key), (p.closure seed).isSome = true

/-- Monotonicity in the change set (needs `Progress`). -/
def MonotoneInChanges : Prop :=
  ∀ (p q : Problem), p.items = q.items → p.groups = q.groups → p.known = q.known →
    p.structural = q.structural → p.onUnknown = q.onUnknown → p.changes ⊆ q.changes →
    ∀ is gs, p.select = .only is gs → ∃ is' gs', q.select = .only is' gs' ∧ is ⊆ is' ∧ gs ⊆ gs'

end Tia
