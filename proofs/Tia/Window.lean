import Tia.Model
namespace Tia

/-- Istanbul counters: a hit count per `file:kind:id` key. -/
abbrev Cov := Key → Nat

def Cov.zero : Cov := fun _ => 0
def Cov.add (a b : Cov) : Cov := fun k => a k + b k
/-- Counters advanced between two snapshots. -/
def Cov.delta (a b : Cov) : Cov := fun k => b k - a k

/-- The things the setup file observes: a gap (collection, hooks, fixtures), a test body, or a
step of work that a finished test left running (a detached fiber) while another test's window is
open. The ledger charges that step to collection, because the test whose window is open did not
start it. A window the step interrupts is two `body` events of the same test. -/
inductive Ev
  | gap (snap : Cov)
  | body (id : Key) (after : Cov)
  | leftover (snap : Cov)

def Ev.snap : Ev → Cov
  | .gap c => c
  | .body _ c => c
  | .leftover c => c

structure Acc where
  boundary   : Cov
  collection : Cov
  tests      : List (Key × Cov)

def sumTests : List (Key × Cov) → Cov
  | [] => Cov.zero
  | (_, c) :: r => Cov.add c (sumTests r)

def Acc.step (a : Acc) : Ev → Acc
  | .gap c => { a with collection := Cov.add a.collection (Cov.delta a.boundary c), boundary := c }
  | .body i c => { a with tests := (i, Cov.delta a.boundary c) :: a.tests, boundary := c }
  | .leftover c => { a with collection := Cov.add a.collection (Cov.delta a.boundary c), boundary := c }

def Acc.run (a : Acc) (es : List Ev) : Acc := es.foldl Acc.step a

def Acc.init (start : Cov) : Acc := ⟨start, Cov.zero, []⟩

/-- Counters never decrease along a trace. -/
def Mono : Cov → List Ev → Prop
  | _, [] => True
  | b, e :: es => (∀ k, b k ≤ e.snap k) ∧ Mono e.snap es

/-- Conservation invariant: every counter increment since `start` is charged exactly once. -/
def Inv (start : Cov) (a : Acc) : Prop :=
  ∀ k, a.collection k + sumTests a.tests k + start k = a.boundary k

theorem inv_step (start : Cov) (a : Acc) (e : Ev) (hi : Inv start a)
    (hm : ∀ k, a.boundary k ≤ e.snap k) : Inv start (a.step e) := by
  intro k
  have h := hi k
  have h2 := hm k
  cases e with
  | gap c =>
    simp only [Acc.step, Ev.snap, Cov.add, Cov.delta] at *
    omega
  | leftover c =>
    simp only [Acc.step, Ev.snap, Cov.add, Cov.delta] at *
    omega
  | body i c =>
    simp only [Acc.step, Ev.snap, sumTests, Cov.add, Cov.delta] at *
    omega

theorem inv_run (start : Cov) :
    ∀ (es : List Ev) (a : Acc), Inv start a → Mono a.boundary es → Inv start (a.run es)
  | [], _, hi, _ => hi
  | e :: es, a, hi, ⟨h1, h2⟩ =>
    inv_run start es (a.step e) (inv_step start a e hi h1) (by simpa [Acc.step, Ev.snap] using
      (show Mono (a.step e).boundary es by cases e <;> simpa [Acc.step, Ev.snap] using h2))

theorem init_inv (start : Cov) : Inv start (Acc.init start) := by
  intro k; simp [Acc.init, Cov.zero, sumTests]

/-- Conservation: collection coverage plus all per-test deltas equals the whole run's delta.
No increment is lost and none is charged twice. -/
theorem conservation (start : Cov) (es : List Ev) (hm : Mono start es) :
    ∀ k, ((Acc.init start).run es).collection k + sumTests ((Acc.init start).run es).tests k
      = Cov.delta start ((Acc.init start).run es).boundary k := by
  intro k
  have := inv_run start es (Acc.init start) (init_inv start) hm k
  simp only [Cov.delta]
  omega

/-- A test's recorded delta depends only on its own window. -/
theorem body_window (a : Acc) (i : Key) (c : Cov) :
    ((a.step (.body i c)).tests.head?) = some (i, Cov.delta a.boundary c) := rfl

/-- A gap never charges a test. -/
theorem gap_leaves_tests (a : Acc) (c : Cov) : (a.step (.gap c)).tests = a.tests := rfl

/-- Leftover work never charges a test, even the one whose window is open. -/
theorem leftover_leaves_tests (a : Acc) (c : Cov) : (a.step (.leftover c)).tests = a.tests := rfl

/-- Everything leftover work advanced is charged to collection. The graph update gives every
test edge of the file its collection (`Covered`), so the open test still depends on it. -/
theorem leftover_charges_collection (a : Acc) (c : Cov) (k : Key) :
    (a.step (.leftover c)).collection k = a.collection k + Cov.delta a.boundary c k := rfl

/-- A window that leftover work interrupts keeps only the test's own steps: the counters the
leftover step advanced (`Cov.delta c₁ c₂`) are in no test entry. -/
theorem window_split_by_leftover (a : Acc) (i : Key) (c₁ c₂ c₃ : Cov) :
    sumTests (((a.step (.body i c₁)).step (.leftover c₂)).step (.body i c₃)).tests =
      Cov.add (Cov.delta c₂ c₃) (Cov.add (Cov.delta a.boundary c₁) (sumTests a.tests)) := rfl

end Tia
