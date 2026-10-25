import Tia.Theorems
import Tia.Check
namespace Tia

/-- Why a run is recorded in full rather than selected, in the order the planner checks. -/
inductive Denial
  | fresh | noGraph | incomplete | coverageIncomplete | fingerprint | environment | changesUnavailable
  deriving DecidableEq, Repr

structure Evidence2 where
  complete         : Bool
  coverageComplete : Bool
  fingerprint      : String
  environment      : String

structure Admission2 where
  fresh            : Bool
  baseline         : Option Evidence2
  coverageRequested : Bool
  current          : String × String
  changesAvailable : Bool
  problem          : Problem

namespace Admission2

def guards (a : Admission2) : List (Bool × Denial) :=
  [ (!a.fresh, .fresh),
    (a.baseline.isSome, .noGraph),
    (a.baseline.all (·.complete), .incomplete),
    (!a.coverageRequested || a.baseline.all (·.coverageComplete), .coverageIncomplete),
    (a.baseline.all (·.fingerprint == a.current.1), .fingerprint),
    (a.baseline.all (·.environment == a.current.2), .environment),
    (a.changesAvailable, .changesUnavailable) ]

def denial (a : Admission2) : Option Denial := firstFail a.guards

def plan (a : Admission2) : Selection :=
  match a.denial with
  | none => a.problem.select
  | some d => .full (toString (repr d))

/-- The shell may call `select` exactly when every guard holds. -/
theorem trusted_iff (a : Admission2) : a.denial = none ↔
    a.fresh = false ∧ a.changesAvailable = true ∧
      ∃ e, a.baseline = some e ∧ e.complete = true ∧
        (a.coverageRequested = true → e.coverageComplete = true) ∧
        e.fingerprint = a.current.1 ∧ e.environment = a.current.2 := by
  unfold denial
  rw [firstFail_none_iff]
  cases hb : a.baseline with
  | none => simp [guards, hb]
  | some e =>
    cases hf : a.fresh <;> cases hc : a.changesAvailable <;> cases hr : a.coverageRequested <;>
      simp [guards, hb, hf, hc, hr, Option.all] <;> grind

/-- Any denial is a full run: uncertainty never narrows the run. -/
theorem denied_is_full (a : Admission2) (d : Denial) (h : a.denial = some d) :
    ∃ because, a.plan = .full because := by
  unfold plan; rw [h]; exact ⟨_, rfl⟩

theorem admitted_is_select (a : Admission2) (h : a.denial = none) :
    a.plan = a.problem.select := by
  unfold plan; rw [h]

/-- Anti-vacuity of the gate: a fresh, complete, matching baseline is admitted. -/
theorem admits_good (p : Problem) (e : Evidence2) (cur : String × String) (cr : Bool)
    (hc : e.complete = true) (hcc : e.coverageComplete = true)
    (hf : e.fingerprint = cur.1) (he : e.environment = cur.2) :
    ({ fresh := false, baseline := some e, coverageRequested := cr, current := cur,
       changesAvailable := true, problem := p } : Admission2).denial = none := by
  rw [trusted_iff]
  exact ⟨rfl, rfl, e, rfl, hc, fun _ => hcc, hf, he⟩

end Admission2
end Tia
