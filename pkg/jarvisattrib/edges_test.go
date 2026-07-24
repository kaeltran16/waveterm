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

func TestBucketCutoffs(t *testing.T) {
	if Bucket(0.3) != "weak" || Bucket(weightLayer2) != "strong" || Bucket(0.5) != "medium" {
		t.Fatalf("buckets: %q %q %q", Bucket(0.3), Bucket(weightLayer2), Bucket(0.5))
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
