namespace Tia

/-! # Protocol path normalization

Segment-level model of `normalizePath`. Splitting on `/`, backslash conversion and the
absolute, drive, URI, NUL and length checks are the shell's job; this module models what
happens to the segments: empty and `.` segments vanish, `..` removes the previous kept
segment, and a `..` with nothing to remove escapes the project root and is rejected. -/

def Clean (s : String) : Prop := s ≠ "" ∧ s ≠ "." ∧ s ≠ ".."

/-- One normalization step over the reversed stack of kept segments. -/
def pushSeg : Option (List String) → String → Option (List String)
  | none, _ => none
  | some st, s =>
    if s = "" ∨ s = "." then some st
    else if s = ".." then
      match st with
      | [] => none
      | _ :: t => some t
    else some (s :: st)

def resolve (xs : List String) : Option (List String) :=
  (xs.foldl pushSeg (some [])).map List.reverse

/-- `none` rejects: a parent escape, or a path that names the project root itself. -/
def normalize (xs : List String) : Option (List String) :=
  match resolve xs with
  | some [] => none
  | r => r

theorem foldl_none (xs : List String) : xs.foldl pushSeg none = none := by
  induction xs with
  | nil => rfl
  | cons _ _ ih => exact ih

theorem pushSeg_clean (st : List String) (hst : ∀ s ∈ st, Clean s) (x : String)
    (st' : List String) (h : pushSeg (some st) x = some st') : ∀ s ∈ st', Clean s := by
  unfold pushSeg at h
  by_cases h1 : x = "" ∨ x = "."
  · simp only [h1, if_true, Option.some.injEq] at h
    subst h; exact hst
  · simp only [h1, if_false] at h
    by_cases h2 : x = ".."
    · simp only [h2, if_true] at h
      cases st with
      | nil => simp at h
      | cons y t =>
        simp only [Option.some.injEq] at h
        subst h
        intro s hs; exact hst s (List.mem_cons_of_mem _ hs)
    · simp only [h2, if_false, Option.some.injEq] at h
      subst h
      intro s hs
      rcases List.mem_cons.1 hs with rfl | hs
      · simp only [not_or] at h1
        exact ⟨h1.1, h1.2, h2⟩
      · exact hst s hs

theorem foldl_clean (xs : List String) :
    ∀ (st : List String), (∀ s ∈ st, Clean s) →
      ∀ st', xs.foldl pushSeg (some st) = some st' → ∀ s ∈ st', Clean s := by
  induction xs with
  | nil =>
    intro st hst st' h
    simp only [List.foldl, Option.some.injEq] at h
    subst h; exact hst
  | cons x xs ih =>
    intro st hst st' h
    simp only [List.foldl] at h
    cases hp : pushSeg (some st) x with
    | none => rw [hp, foldl_none] at h; simp at h
    | some st₁ =>
      rw [hp] at h
      exact ih st₁ (pushSeg_clean st hst x st₁ hp) st' h

/-- Every kept segment is a real name: never empty, `.` or `..`. -/
theorem normalize_clean (xs ys : List String) (h : normalize xs = some ys) :
    ∀ s ∈ ys, Clean s := by
  unfold normalize at h
  cases hr : resolve xs with
  | none => rw [hr] at h; simp at h
  | some zs =>
    rw [hr] at h
    have hz : zs = ys := by cases zs <;> simp_all
    subst hz
    unfold resolve at hr
    cases hf : xs.foldl pushSeg (some []) with
    | none => rw [hf] at hr; simp at hr
    | some st =>
      rw [hf] at hr
      simp only [Option.map_some, Option.some.injEq] at hr
      subst hr
      intro s hs
      exact foldl_clean xs [] (by simp) st hf s (List.mem_reverse.1 hs)

theorem normalize_nonempty (xs ys : List String) (h : normalize xs = some ys) : ys ≠ [] := by
  unfold normalize at h
  cases hr : resolve xs with
  | none => rw [hr] at h; simp at h
  | some zs =>
    rw [hr] at h
    cases zs with
    | nil => simp at h
    | cons z zs =>
      simp only [Option.some.injEq] at h
      rw [← h]; exact List.cons_ne_nil z zs

theorem foldl_clean_push (ys : List String) (hy : ∀ s ∈ ys, Clean s) :
    ∀ st, ys.foldl pushSeg (some st) = some (ys.reverse ++ st) := by
  induction ys with
  | nil => intro st; rfl
  | cons y ys ih =>
    intro st
    have hc := hy y (List.mem_cons_self ..)
    have hstep : pushSeg (some st) y = some (y :: st) := by
      unfold pushSeg
      have h1 : ¬(y = "" ∨ y = ".") := by
        intro h; rcases h with h | h
        · exact hc.1 h
        · exact hc.2.1 h
      simp only [h1, if_false, hc.2.2, if_false]
    simp only [List.foldl, hstep]
    rw [ih (fun s hs => hy s (List.mem_cons_of_mem _ hs))]
    simp

/-- Normalization is idempotent: a normalized path normalizes to itself. -/
theorem normalize_idem (xs ys : List String) (h : normalize xs = some ys) :
    normalize ys = some ys := by
  have hc := normalize_clean xs ys h
  have hne := normalize_nonempty xs ys h
  have hres : resolve ys = some ys := by
    unfold resolve
    rw [foldl_clean_push ys hc []]
    simp
  unfold normalize
  rw [hres]
  cases ys with
  | nil => exact absurd rfl hne
  | cons _ _ => rfl

/-! Anti-vacuity: useful paths are accepted, inner `..` resolves, escapes are rejected. -/
example : normalize ["src", "a.ts"] = some ["src", "a.ts"] := by decide
example : normalize ["", ".", "src", "", "a.ts"] = some ["src", "a.ts"] := by decide
example : normalize ["src", "..", "lib", "b.ts"] = some ["lib", "b.ts"] := by decide
example : normalize ["src", ""] = some ["src"] := by decide
example : normalize [".."] = none := by decide
example : normalize ["src", "..", ".."] = none := by decide
example : normalize ["src", ".."] = none := by decide
example : normalize ["."] = none := by decide

end Tia
