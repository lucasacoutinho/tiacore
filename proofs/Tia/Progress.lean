import Tia.Theorems
namespace Tia
open Problem

/-- Every `needs` entry of a member is a member. -/
def Fix (items : List Item) (s : List Key) : Prop :=
  ∀ it ∈ items, it.id ∈ s → ∀ k ∈ it.needs, k ∈ s

/-- Number of items whose id is not yet in `s`. -/
def missing (items : List Item) (s : List Key) : Nat :=
  (items.filter fun it => !s.contains it.id).length

theorem step_sub (items : List Item) (s : List Key) : ∀ k ∈ s, k ∈ step items s :=
  fun _ h => List.mem_append_left _ h

theorem mem_step (items : List Item) (s : List Key) (k : Key) :
    k ∈ step items s ↔ k ∈ s ∨ ∃ it ∈ items, it.id ∈ s ∧ k ∈ it.needs := by
  simp only [step, List.mem_append, List.mem_filter, List.mem_flatMap,
    List.contains_iff_mem, Bool.not_eq_true']
  constructor
  · rintro (h | ⟨⟨it, ⟨hit, hs⟩, hk⟩, _⟩)
    · exact Or.inl h
    · exact Or.inr ⟨it, hit, hs, hk⟩
  · rintro (h | ⟨it, hit, hs, hk⟩)
    · exact Or.inl h
    · by_cases hk' : k ∈ s
      · exact Or.inl hk'
      · exact Or.inr ⟨⟨it, ⟨hit, hs⟩, hk⟩, by simpa using hk'⟩

theorem fix_step (items : List Item) (s : List Key) : Fix items s → ∀ k ∈ step items s, k ∈ s := by
  intro hf k hk
  rcases (mem_step items s k).1 hk with h | ⟨it, hit, hs, hk'⟩
  · exact h
  · exact hf it hit hs k hk'

theorem close_within (items : List Item) (s : List Key) (hf : Fix items s) :
    ∀ (n : Nat) (s' : List Key), (∀ k ∈ s', k ∈ s) → ∀ k ∈ close items n s', k ∈ s
  | 0, _, h => h
  | n + 1, s', h => by
      apply close_within items s hf n
      intro k hk
      rcases (mem_step items s' k).1 hk with h' | ⟨it, hit, hs, hk'⟩
      · exact h k h'
      · exact hf it hit (h _ hs) k hk'

theorem closedB_of_fix (items : List Item) (s : List Key) (h : Fix items s) :
    closedB items s = true := by
  simp only [closedB, List.all_eq_true, Bool.or_eq_true, Bool.not_eq_true',
    List.contains_iff_mem]
  intro it hit
  by_cases hs : it.id ∈ s
  · right; exact h it hit hs
  · left; simpa using hs

theorem fix_of_closedB (items : List Item) (s : List Key) (h : closedB items s = true) :
    Fix items s := closedB_spec items s h

theorem fix_close (items : List Item) (s : List Key) (n : Nat) (hf : Fix items s) :
    Fix items (close items n s) := by
  intro it hit hs k hk
  have h1 : it.id ∈ s := close_within items s hf n s (fun _ h => h) _ hs
  exact mem_close_of_mem items n s k (hf it hit h1 k hk)

theorem countP_lt_of_witness {α : Type} (p q : α → Bool) :
    ∀ (l : List α), (∀ x ∈ l, p x = true → q x = true) →
      (∃ x ∈ l, q x = true ∧ p x = false) → l.countP p < l.countP q
  | [], _, ⟨x, hx, _⟩ => by simp at hx
  | a :: l, himp, ⟨x, hx, hq, hp⟩ => by
      have himp' : ∀ y ∈ l, p y = true → q y = true :=
        fun y hy => himp y (List.mem_cons_of_mem _ hy)
      have hmono : l.countP p ≤ l.countP q := List.countP_mono_left himp'
      have hia : p a = true → q a = true := himp a List.mem_cons_self
      rcases List.mem_cons.1 hx with rfl | hx'
      · rw [List.countP_cons, List.countP_cons, hq, hp]
        simp only [Bool.false_eq_true, if_false, if_true]
        omega
      · have := countP_lt_of_witness p q l himp' ⟨x, hx', hq, hp⟩
        rw [List.countP_cons, List.countP_cons]
        cases hpa : p a <;> cases hqa : q a
        · simp only [Bool.false_eq_true, if_false]; omega
        · simp only [Bool.false_eq_true, if_false, if_true]; omega
        · rw [hpa, hqa] at hia; exact absurd (hia rfl) (by decide)
        · simp only [if_true]; omega

/-- Number of items whose id is not yet in `s` (as a `countP`). -/
def miss (items : List Item) (s : List Key) : Nat :=
  items.countP fun it => !s.contains it.id

theorem notC (s : List Key) (k : Key) : (!s.contains k) = true ↔ k ∉ s := by simp

theorem miss_le (items : List Item) (s : List Key) : miss items s ≤ items.length :=
  List.countP_le_length

theorem miss_mono (items : List Item) (s s' : List Key) (h : ∀ k ∈ s, k ∈ s') :
    miss items s' ≤ miss items s := by
  unfold miss
  apply List.countP_mono_left
  intro it _ hp
  rw [notC] at hp ⊢
  exact fun hm => hp (h _ hm)

theorem miss_lt (items : List Item) (s s' : List Key) (h : ∀ k ∈ s, k ∈ s')
    (it : Item) (hit : it ∈ items) (h1 : it.id ∈ s') (h2 : it.id ∉ s) :
    miss items s' < miss items s := by
  unfold miss
  apply countP_lt_of_witness
  · intro x _ hp
    rw [notC] at hp ⊢
    exact fun hm => hp (h _ hm)
  · exact ⟨it, hit, by simpa using h2, by simpa using h1⟩

/-- Fuel adequacy: with fuel above the number of unplaced items, the closure is closed. -/
theorem close_closed (items : List Item) :
    ∀ (n : Nat) (s : List Key), miss items s < n → Fix items (close items n s)
  | 0, s, h => by omega
  | n + 1, s, h => by
      by_cases hfix : Fix items s
      · exact fix_close items s (n + 1) hfix
      · by_cases hnew : ∃ it ∈ items, it.id ∈ step items s ∧ it.id ∉ s
        · obtain ⟨it, hit, h1, h2⟩ := hnew
          have := miss_lt items s (step items s) (step_sub items s) it hit h1 h2
          exact close_closed items n (step items s) (by omega)
        · have hnew' : ∀ it ∈ items, it.id ∈ step items s → it.id ∈ s :=
            fun it hit hs => Classical.byContradiction fun hn => hnew ⟨it, hit, hs, hn⟩
          have hfix' : Fix items (step items s) := by
            intro it hit hs k hk
            have hs' : it.id ∈ s := hnew' it hit hs
            exact (mem_step items s k).2 (Or.inr ⟨it, hit, hs', hk⟩)
          show Fix items (close items n (step items s))
          exact fix_close items (step items s) n hfix'

/-- Progress: the closure always converges, so the `none` branch of `closure` is dead. -/
theorem progress (p : Problem) (seed : List Key) : (p.closure seed).isSome = true := by
  unfold Problem.closure
  have h := close_closed p.items (p.items.length + 2) seed
    (by have := miss_le p.items seed; omega)
  simp [closedB_of_fix _ _ h]

end Tia
