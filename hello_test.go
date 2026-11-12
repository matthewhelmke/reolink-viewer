package hello

import "testing"

func TestGreeting(t *testing.T) {
	if got := Greeting("Ada"); got != "Hello, Ada!" {
		t.Errorf("Greeting(\"Ada\") = %q, want %q", got, "Hello, Ada!")
	}
}
