import Tia.Theorems
namespace Tia
open Problem

inductive State | passed | failed | skipped
  deriving DecidableEq

structure Cached where
  id    : Key
  group : Key
  state : State

/-- A cached outcome may be replayed to reporters only when nothing obliges a rerun. -/
def replayable (is gs : List Key) (r : Cached) : Bool :=
  r.state != .failed && !is.contains r.id && !gs.contains r.group

theorem replayable_not_failed (is gs : List Key) (r : Cached) (h : replayable is gs r = true) :
    r.state ≠ .failed := by
  intro hs; simp [replayable, hs] at h

/-- Replay soundness: a result for an item the contract calls affected is never replayed. -/
theorem replay_sound (p : Problem) (is gs : List Key) (h : p.select = .only is gs)
    (it : Item) (hit : it ∈ p.items) (haff : Affected p it) (st : State) :
    replayable is gs ⟨it.id, it.group, st⟩ = false := by
  have := sound p is gs h it hit haff
  simp [replayable, this]

/-- A failed result is always re-executed: `rerun` items are selected, and failed is never replayable. -/
theorem failed_never_replayed (is gs : List Key) (r : Cached) (h : r.state = .failed) :
    replayable is gs r = false := by simp [replayable, h]

/-- Totality: each cached result is replayed or executed, never both and never neither. -/
def mustRun (is gs : List Key) (r : Cached) : Bool :=
  r.state == .failed || is.contains r.id || gs.contains r.group

theorem replay_xor_run (is gs : List Key) (r : Cached) :
    replayable is gs r = !mustRun is gs r := by
  have h1 : (r.state != .failed) = !(r.state == .failed) := by cases r.state <;> decide
  simp only [replayable, mustRun, h1]
  cases (r.state == .failed) <;> cases is.contains r.id <;> cases gs.contains r.group <;> rfl

/-- Anti-vacuity: replay does happen for an untouched passing result. -/
example : replayable [] [] ⟨"t", "f", .passed⟩ = true := by decide

end Tia
