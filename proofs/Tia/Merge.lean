import Tia.Model
namespace Tia

/-! Partition merge. Records are association lists; values are opaque (`Nat` stands for
"canonical JSON of the record"; equality is the legacy `JSON.stringify` comparison). -/

abbrev Rec := List (Key × Nat)

def find : Rec → Key → Option Nat
  | [], _ => none
  | (k', v) :: r, k => if k' == k then some v else find r k

def Functional (r : Rec) : Prop := ∀ k v v', (k, v) ∈ r → (k, v') ∈ r → v = v'

/-- Insert one entry; fail on a disagreeing value for the same key. -/
def addRec (acc : Rec) (kv : Key × Nat) : Option Rec :=
  match find acc kv.1 with
  | none => some (acc ++ [kv])
  | some v' => if v' == kv.2 then some acc else none

def mergeAll (xs : Rec) : Option Rec := xs.foldlM addRec []

theorem find_none (r : Rec) (k : Key) : find r k = none → ∀ v, (k, v) ∉ r := by
  induction r with
  | nil => simp
  | cons p r ih =>
    obtain ⟨k', v'⟩ := p
    intro h v hm
    simp only [find] at h
    by_cases hk : k' == k
    · simp [hk] at h
    · simp only [hk, Bool.false_eq_true, if_false] at h
      rcases List.mem_cons.1 hm with e | e
      · simp at e; exact hk (by simp [e.1])
      · exact ih h v e

theorem find_some (r : Rec) (k : Key) (v : Nat) : find r k = some v → (k, v) ∈ r := by
  induction r with
  | nil => simp [find]
  | cons p r ih =>
    obtain ⟨k', v'⟩ := p
    intro h
    simp only [find] at h
    by_cases hk : k' == k
    · simp only [hk, if_true, Option.some.injEq] at h
      have : k' = k := by simpa using hk
      subst this; subst h; exact List.mem_cons_self
    · simp only [hk, Bool.false_eq_true, if_false] at h
      exact List.mem_cons_of_mem _ (ih h)

theorem addRec_spec (acc : Rec) (kv : Key × Nat) (r : Rec) (h : addRec acc kv = some r)
    (hf : Functional acc) :
    Functional r ∧ (∀ q ∈ acc, q ∈ r) ∧ kv ∈ r ∧ (∀ q ∈ r, q ∈ acc ∨ q = kv) := by
  obtain ⟨k, v⟩ := kv
  unfold addRec at h
  cases hfd : find acc k with
  | none =>
    rw [hfd] at h
    simp only [Option.some.injEq] at h
    subst h
    have hn := find_none acc k hfd
    refine ⟨?_, fun q hq => List.mem_append_left _ hq, by simp, ?_⟩
    · intro k1 v1 v2 h1 h2
      simp only [List.mem_append, List.mem_singleton, Prod.mk.injEq] at h1 h2
      rcases h1 with h1 | ⟨e1, e2⟩ <;> rcases h2 with h2 | ⟨e3, e4⟩
      · exact hf _ _ _ h1 h2
      · subst e3; exact absurd h1 (hn _)
      · subst e1; exact absurd h2 (hn _)
      · rw [e2, e4]
    · intro q hq
      rcases List.mem_append.1 hq with hq | hq
      · exact Or.inl hq
      · exact Or.inr (List.mem_singleton.1 hq)
  | some v' =>
    rw [hfd] at h
    by_cases he : (v' == v) = true
    · simp only [he, if_true, Option.some.injEq] at h
      subst h
      have : v' = v := by simpa using he
      subst this
      exact ⟨hf, fun q hq => hq, find_some acc k v' hfd, fun q hq => Or.inl hq⟩
    · simp only [he, Bool.false_eq_true, if_false] at h
      exact absurd h (by simp)

theorem foldl_spec :
    ∀ (xs acc r : Rec), xs.foldlM addRec acc = some r → Functional acc →
      Functional r ∧ (∀ q ∈ acc, q ∈ r) ∧ (∀ q ∈ xs, q ∈ r) ∧ (∀ q ∈ r, q ∈ acc ∨ q ∈ xs)
  | [], acc, r, h, hf => by
      simp only [List.foldlM, pure, Option.some.injEq] at h
      subst h
      exact ⟨hf, fun q hq => hq, by simp, fun q hq => Or.inl hq⟩
  | x :: xs, acc, r, h, hf => by
      simp only [List.foldlM, bind] at h
      cases ha : addRec acc x with
      | none => rw [ha] at h; simp [Option.bind] at h
      | some acc' =>
        rw [ha] at h
        simp only [Option.bind_some] at h
        obtain ⟨hf', hsub, hx, hback⟩ := addRec_spec acc x acc' ha hf
        obtain ⟨h1, h2, h3, h4⟩ := foldl_spec xs acc' r h hf'
        refine ⟨h1, fun q hq => h2 q (hsub q hq), ?_, ?_⟩
        · intro q hq
          rcases List.mem_cons.1 hq with rfl | hq
          · exact h2 _ hx
          · exact h3 q hq
        · intro q hq
          rcases h4 q hq with hq | hq
          · rcases hback q hq with hq | rfl
            · exact Or.inl hq
            · exact Or.inr List.mem_cons_self
          · exact Or.inr (List.mem_cons_of_mem _ hq)

/-- Merging loses nothing, invents nothing, and yields a single value per key. -/
theorem mergeAll_spec (xs r : Rec) (h : mergeAll xs = some r) :
    Functional r ∧ (∀ q ∈ xs, q ∈ r) ∧ (∀ q ∈ r, q ∈ xs) := by
  obtain ⟨h1, _, h3, h4⟩ := foldl_spec xs [] r h (by intro k v v' a; simp at a)
  exact ⟨h1, h3, fun q hq => (h4 q hq).elim (by simp) id⟩

/-- Disagreeing records for one key are rejected, never silently resolved. -/
theorem mergeAll_conflict (xs : Rec) (k : Key) (v v' : Nat) (h1 : (k, v) ∈ xs)
    (h2 : (k, v') ∈ xs) (hne : v ≠ v') : mergeAll xs = none := by
  cases hm : mergeAll xs with
  | none => rfl
  | some r =>
    obtain ⟨hf, hs, _⟩ := mergeAll_spec xs r hm
    exact absurd (hf k v v' (hs _ h1) (hs _ h2)) hne

/-- Agreeing records always merge (anti-vacuity: the merge is not constant `none`). -/
example : mergeAll [("a", 1), ("b", 2), ("a", 1)] = some [("a", 1), ("b", 2)] := by decide

/-! ### Fragment admission -/

structure Frag where
  index     : Nat
  total     : Nat
  group     : Key
  fingerprint : Key
  baseline  : Key
  complete  : Bool
  gen       : Nat
  covComplete : Bool
  edges     : Rec

/-- A fragment joins the merge when it agrees with the first on identity and is itself partial. -/
def accepts (f0 f : Frag) : Bool :=
  f.total == f0.total && f.group == f0.group && !f.complete &&
    f.fingerprint == f0.fingerprint && f.baseline == f0.baseline &&
    1 ≤ f.index && f.index ≤ f0.total

/-- Two accepted fragments for one slot with different generations make the set ambiguous. -/
def ambiguous (vs : List Frag) : Bool :=
  vs.any fun a => vs.any fun b => a.index == b.index && a.gen != b.gen

def coversAll (vs : List Frag) (total : Nat) : Bool :=
  (List.range total).all fun i => vs.any (·.index == i + 1)

structure Merged where
  complete : Bool
  covComplete : Bool
  edges : Rec

def mergeFrags (fs : List Frag) : Option Merged :=
  match fs with
  | [] => none
  | f0 :: _ =>
    let vs := fs.filter (accepts f0)
    if ambiguous vs || !coversAll vs f0.total then none
    else
      match mergeAll (vs.flatMap (·.edges)) with
      | none => none
      | some e => some ⟨true, vs.all (·.covComplete), e⟩

theorem merge_complete (fs : List Frag) (m : Merged) (h : mergeFrags fs = some m) :
    m.complete = true ∧ ∃ f0, ∀ i, 1 ≤ i → i ≤ f0.total →
      ∃ f ∈ fs, accepts f0 f = true ∧ f.index = i := by
  cases fs with
  | nil => simp [mergeFrags] at h
  | cons f0 rest =>
    unfold mergeFrags at h
    simp only at h
    by_cases hb : (ambiguous ((f0 :: rest).filter (accepts f0)) ||
        !coversAll ((f0 :: rest).filter (accepts f0)) f0.total) = true
    · simp [hb] at h
    · simp only [hb, Bool.false_eq_true, if_false] at h
      cases he : mergeAll (((f0 :: rest).filter (accepts f0)).flatMap (·.edges)) with
      | none => rw [he] at h; simp at h
      | some e =>
        rw [he] at h
        simp only [Option.some.injEq] at h
        subst h
        refine ⟨rfl, f0, fun i hi1 hi2 => ?_⟩
        have hc : coversAll ((f0 :: rest).filter (accepts f0)) f0.total = true := by
          simp only [Bool.or_eq_true, Bool.not_eq_true'] at hb
          cases hh : coversAll ((f0 :: rest).filter (accepts f0)) f0.total
          · simp [hh] at hb
          · rfl
        unfold coversAll at hc
        simp only [List.all_eq_true, List.mem_range, List.any_eq_true, beq_iff_eq,
          List.mem_filter] at hc
        obtain ⟨f, ⟨hf1, hf2⟩, hf3⟩ := hc (i - 1) (by omega)
        exact ⟨f, hf1, hf2, by omega⟩

/-- A missing slot is a rejection. -/
theorem merge_missing (f0 : Frag) (rest : List Frag) (i : Nat) (hi1 : 1 ≤ i) (hi2 : i ≤ f0.total)
    (hmiss : ∀ f ∈ f0 :: rest, accepts f0 f = true → f.index ≠ i) :
    mergeFrags (f0 :: rest) = none := by
  unfold mergeFrags
  simp only
  have : coversAll ((f0 :: rest).filter (accepts f0)) f0.total = false := by
    unfold coversAll
    cases hh : (List.range f0.total).all fun j => ((f0 :: rest).filter (accepts f0)).any (·.index == j + 1)
    · rfl
    · exfalso
      simp only [List.all_eq_true, List.mem_range, List.any_eq_true, beq_iff_eq,
        List.mem_filter] at hh
      obtain ⟨f, ⟨hf1, hf2⟩, hf3⟩ := hh (i - 1) (by omega)
      exact hmiss f hf1 hf2 (by omega)
  simp [this]

end Tia
