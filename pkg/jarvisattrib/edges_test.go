// pkg/jarvisattrib/edges_test.go
package jarvisattrib

import "testing"

func TestConfidenceAndProvenanceFromLayers(t *testing.T) {
	if c := confidenceFor([]int{2, 3}); c != 0.8 {
		t.Fatalf("max weight over {2,3} = %v, want 0.8", c)
	}
	if p := provenanceFor([]int{3, 2}); p != provTicket {
		t.Fatalf("provenance for {3,2} = %q, want %q (strongest layer wins)", p, provTicket)
	}
	if p := provenanceFor([]int{1}); p != provDispatch {
		t.Fatalf("provenance for {1} = %q, want %q", p, provDispatch)
	}
}

func TestBucketForIsTotalOverFiringLayers(t *testing.T) {
	cases := []struct {
		layers []int
		want   string
	}{
		{[]int{1}, "strong"},    // canonical dispatch reference
		{[]int{2}, "medium"},    // identifier (ticket) match
		{[]int{3}, "weak"},      // structural correlation
		{[]int{4}, "weak"},      // semantic similarity
		{[]int{3, 2}, "medium"}, // strongest layer wins regardless of input order
		{[]int{2, 1}, "strong"},
		{[]int{4, 3}, "weak"},
		{nil, ""}, // no layers means no signal: absent, never a fabricated "weak"
		{[]int{}, ""},
		{[]int{9}, ""}, // unknown layer is not silently labelled
	}
	for _, c := range cases {
		if got := BucketFor(c.layers); got != c.want {
			t.Errorf("BucketFor(%v) = %q, want %q", c.layers, got, c.want)
		}
	}
}

// The guard against the defect returning: every bucket name the wire type advertises must be
// producible by some layer that can actually fire. Re-deriving the bucket from a float threshold
// fails this, because no layer weight falls inside the old [0.4, 0.75) medium band.
func TestEveryBucketIsReachableFromSomeFiringLayer(t *testing.T) {
	reachable := map[string]bool{}
	for _, l := range []int{1, 2, 3, 4} {
		reachable[BucketFor([]int{l})] = true
	}
	for _, want := range []string{"weak", "medium", "strong"} {
		if !reachable[want] {
			t.Errorf("bucket %q is unreachable from any firing layer; reachable set = %v", want, reachable)
		}
	}
}

func TestRefConversionRoundTrip(t *testing.T) {
	oref, ok := refToRunORef(runRef("abc123"))
	if !ok || oref != "run:abc123" {
		t.Fatalf("refToRunORef = %q,%v want run:abc123,true", oref, ok)
	}
	back, ok := orefToRunRef("run:abc123")
	if !ok || back != "run-abc123" {
		t.Fatalf("orefToRunRef = %q,%v want run-abc123,true", back, ok)
	}
	if _, ok := refToRunORef("dec-9f0"); ok {
		t.Fatal("a decision ref must not convert to a run oref")
	}
}
