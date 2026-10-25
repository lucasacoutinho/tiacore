import Tia.Check
namespace Tia

structure GraphFacts where
  complete         : Bool
  partition        : Bool
  coverageComplete : Bool

/-- `publish` accepts a complete graph or a partition fragment. -/
def publishable (g : GraphFacts) : Bool := g.complete || g.partition

/-- `promote` accepts only a complete, non-partition graph, and complete coverage if required. -/
def promotable (requireCoverage : Bool) (g : GraphFacts) : Bool :=
  g.complete && !g.partition && (!requireCoverage || g.coverageComplete)

theorem promotable_publishable (rc : Bool) (g : GraphFacts) (h : promotable rc g = true) :
    publishable g = true := by
  simp [promotable, publishable] at *; simp [h.1.1]

/-- A partition fragment is never a promoted baseline. -/
theorem partition_not_promotable (rc : Bool) (g : GraphFacts) (h : g.partition = true) :
    promotable rc g = false := by simp [promotable, h]

theorem promotable_complete (rc : Bool) (g : GraphFacts) (h : promotable rc g = true) :
    g.complete = true ∧ g.partition = false ∧ (rc = true → g.coverageComplete = true) := by
  cases hc : g.complete <;> cases hp : g.partition <;> cases rc <;> cases hv : g.coverageComplete <;>
    simp_all [promotable]

theorem promotable_of (rc : Bool) (g : GraphFacts) (hc : g.complete = true)
    (hp : g.partition = false) (hv : rc = true → g.coverageComplete = true) :
    promotable rc g = true := by
  cases rc <;> simp_all [promotable]

/-! ### Trust verdict -/

inductive Untrusted
  | noAttestation | keyUntrusted | keyInvalid | badSignature | notYetValid | expired
  | badWindow | tooOld | predatesPolicy | digestMismatch | identityMismatch
  | runnerMismatch | notPromoted | producerUntrusted | sourceUntrusted
  deriving DecidableEq, Repr

structure Trust where
  hasAttestation : Bool
  allowUnsigned  : Bool
  keyKnown       : Bool
  keyUsable      : Bool
  signatureOk    : Bool         -- trust boundary: crypto
  now : Nat
  issuedAt : Nat
  expiresAt : Nat
  skew           : Nat          -- 5 minutes in ms
  maxAge         : Option Nat   -- ms
  notBefore      : Option Nat
  digestOk : Bool
  identityOk : Bool
  runnerOk : Bool
  requirePromoted : Bool
  promoted : Bool
  producerOk : Bool
  sourceOk : Bool

def Trust.guards (t : Trust) : List (Bool × Untrusted) :=
  [ (t.keyKnown, .keyUntrusted), (t.keyUsable, .keyInvalid), (t.signatureOk, .badSignature),
    (decide (t.issuedAt ≤ t.now + t.skew), .notYetValid),
    (decide (t.now < t.expiresAt), .expired),
    (decide (t.issuedAt < t.expiresAt), .badWindow),
    (t.maxAge.all fun m => decide (t.now - t.issuedAt ≤ m), .tooOld),
    (t.notBefore.all fun n => decide (n ≤ t.issuedAt), .predatesPolicy),
    (t.digestOk, .digestMismatch), (t.identityOk, .identityMismatch), (t.runnerOk, .runnerMismatch),
    (!t.requirePromoted || t.promoted, .notPromoted),
    (t.producerOk, .producerUntrusted), (t.sourceOk, .sourceUntrusted) ]

/-- `none` means trusted. An absent attestation is trusted only under `allowUnsigned`. -/
def Trust.verdict (t : Trust) : Option Untrusted :=
  if t.hasAttestation then firstFail t.guards
  else if t.allowUnsigned then none else some .noAttestation

theorem unsigned_denied_by_default (t : Trust) (h1 : t.hasAttestation = false)
    (h2 : t.allowUnsigned = false) : t.verdict = some .noAttestation := by
  simp [Trust.verdict, h1, h2]

/-- Trusted means every policy guard held; in particular promotion, expiry, and the digest. -/
theorem trusted_guards (t : Trust) (h1 : t.hasAttestation = true) (h : t.verdict = none) :
    t.signatureOk = true ∧ t.digestOk = true ∧ t.now < t.expiresAt ∧
      (t.requirePromoted = true → t.promoted = true) := by
  simp only [Trust.verdict, h1, if_true] at h
  have := (firstFail_none_iff _).1 h
  simp only [Trust.guards, List.mem_cons, List.not_mem_nil, or_false, forall_eq_or_imp,
    Bool.or_eq_true, Bool.not_eq_true', decide_eq_true_eq] at this
  obtain ⟨_, _, hs, _, he, _, _, _, hd, _, _, hp, _⟩ := this
  exact ⟨hs, hd, he, fun r => by simpa [r] using hp⟩

theorem trusted_of_guards (t : Trust) (h1 : t.hasAttestation = true)
    (hg : ∀ c ∈ t.guards, c.1 = true) : t.verdict = none := by
  simp only [Trust.verdict, h1, if_true]
  exact (firstFail_none_iff _).2 hg

def goodTrust : Trust where
  hasAttestation := true
  allowUnsigned := false
  keyKnown := true
  keyUsable := true
  signatureOk := true
  now := 10
  issuedAt := 5
  expiresAt := 20
  skew := 3
  maxAge := none
  notBefore := none
  digestOk := true
  identityOk := true
  runnerOk := true
  requirePromoted := true
  promoted := true
  producerOk := true
  sourceOk := true

/-- Anti-vacuity: a fully valid attestation is trusted. -/
example : goodTrust.verdict = none := by decide

/-- An expired attestation is denied even when every other guard holds. -/
example : ({ goodTrust with now := 25 } : Trust).verdict = some .expired := by decide

end Tia
