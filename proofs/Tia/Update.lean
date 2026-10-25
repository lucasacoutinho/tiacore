import Tia.Model
import Tia.Theorems
namespace Tia
open Problem

/-! Graph update for one test file: how a run's observations replace or extend the file's
stored evidence. `collection` is the file's collection evidence: what its module load and
hooks touched, outside every test body. Each stored test edge is the test's body
dependencies plus the collection. Lists stand for sets; only membership matters. -/

structure FileEvidence where
  collection : List Path
  tests      : List (Key × List Path)

/-- The invariant the update keeps: every test edge contains the file's collection. -/
def Covered (e : FileEvidence) : Prop :=
  ∀ t ∈ e.tests, ∀ c ∈ e.collection, c ∈ t.2

/-- A run that executed every test of the file replaces its evidence. -/
def updateFull (observed : List Path) (executed : List (Key × List Path)) : FileEvidence :=
  { collection := observed
    tests := executed.map fun t => (t.1, t.2 ++ observed) }

/-- The edge a test keeps after a partial run: its new body edge if it ran, else its old
edge, extended with the merged collection. -/
def partialEdge (executed : List (Key × List Path)) (merged : List Path)
    (t : Key × List Path) : Key × List Path :=
  match executed.find? (·.1 == t.1) with
  | some n => (t.1, n.2 ++ merged)
  | none => (t.1, t.2 ++ merged)

/-- A run that replayed some tests of the file keeps the previous collection and adds what
it observed. Tests seen for the first time join with their new edge. -/
def updatePartial (previous : FileEvidence) (observed : List Path)
    (executed : List (Key × List Path)) : FileEvidence :=
  let merged := previous.collection ++ observed
  { collection := merged
    tests := previous.tests.map (partialEdge executed merged) ++
      (executed.filter fun n => !previous.tests.any (·.1 == n.1)).map
        fun n => (n.1, n.2 ++ merged) }

/-! ## Obligations -/

/-- A full run's evidence is exactly what it observed. -/
theorem full_replaces (observed : List Path) (executed : List (Key × List Path)) :
    (updateFull observed executed).collection = observed ∧
      ∀ t ∈ (updateFull observed executed).tests, ∃ n ∈ executed, t = (n.1, n.2 ++ observed) := by
  refine ⟨rfl, ?_⟩
  intro t ht
  simp only [updateFull, List.mem_map] at ht
  obtain ⟨n, hn, rfl⟩ := ht
  exact ⟨n, hn, rfl⟩

theorem full_covered (observed : List Path) (executed : List (Key × List Path)) :
    Covered (updateFull observed executed) := by
  intro t ht c hc
  simp only [updateFull, List.mem_map] at ht
  obtain ⟨n, _, rfl⟩ := ht
  exact List.mem_append_right _ hc

/-- A partial run never shrinks the file's collection evidence. -/
theorem partial_keeps_collection (previous : FileEvidence) (observed : List Path)
    (executed : List (Key × List Path)) :
    ∀ c ∈ previous.collection, c ∈ (updatePartial previous observed executed).collection :=
  fun _ hc => List.mem_append_left _ hc

/-- A partial run records what it observed. -/
theorem partial_keeps_observed (previous : FileEvidence) (observed : List Path)
    (executed : List (Key × List Path)) :
    ∀ c ∈ observed, c ∈ (updatePartial previous observed executed).collection :=
  fun _ hc => List.mem_append_right _ hc

theorem partialEdge_covers (executed : List (Key × List Path)) (merged : List Path)
    (t : Key × List Path) : ∀ c ∈ merged, c ∈ (partialEdge executed merged t).2 := by
  intro c hc
  unfold partialEdge
  split <;> exact List.mem_append_right _ hc

/-- After a partial run every test edge of the file, executed or replayed, still contains
the file's collection. -/
theorem partial_covered (previous : FileEvidence) (observed : List Path)
    (executed : List (Key × List Path)) :
    Covered (updatePartial previous observed executed) := by
  intro t ht c hc
  simp only [updatePartial, List.mem_append, List.mem_map, List.mem_filter] at ht hc ⊢
  rcases ht with ⟨u, _, rfl⟩ | ⟨n, _, rfl⟩
  · exact partialEdge_covers executed _ u c (List.mem_append.2 hc)
  · exact List.mem_append_right _ (List.mem_append.2 hc)

/-- A replayed test keeps every dependency it had. -/
theorem partial_replayed_keeps (previous : FileEvidence) (observed : List Path)
    (executed : List (Key × List Path)) (t : Key × List Path) (ht : t ∈ previous.tests)
    (hr : executed.find? (·.1 == t.1) = none) :
    (t.1, t.2 ++ (previous.collection ++ observed)) ∈
      (updatePartial previous observed executed).tests := by
  simp only [updatePartial]
  apply List.mem_append_left
  apply List.mem_map.2
  exact ⟨t, ht, by simp [partialEdge, hr]⟩

/-- Why carrying the collection forward is sound. When every test of group `k` records the
paths `C` (the stored collection, by `Covered`), a change to any path of `C` selects every
test of the group. So a run that replayed a test of the group saw no change in `C`, and the
previous collection evidence still describes the file. -/
theorem collection_change_selects_group (p : Problem) (is gs : List Key)
    (h : p.select = .only is gs) (k : Key) (C : List Path)
    (hC : ∀ it ∈ p.items, it.group = k → ∀ c ∈ C, c ∈ it.deps)
    (c : Path) (hcC : c ∈ C) (hc : c ∈ p.changes) :
    ∀ it ∈ p.items, it.group = k → it.id ∈ is :=
  fun it hit hg => sound_deps p is gs h it hit c hc (hC it hit hg c hcC)

/-- Contrapositive used by the update: a replayed test of the group means no path of the
collection changed. -/
theorem replayed_means_collection_unchanged (p : Problem) (is gs : List Key)
    (h : p.select = .only is gs) (k : Key) (C : List Path)
    (hC : ∀ it ∈ p.items, it.group = k → ∀ c ∈ C, c ∈ it.deps)
    (it : Item) (hit : it ∈ p.items) (hg : it.group = k) (hnot : it.id ∉ is) :
    ∀ c ∈ C, c ∉ p.changes :=
  fun c hcC hc => hnot (collection_change_selects_group p is gs h k C hC c hcC hc it hit hg)

end Tia
