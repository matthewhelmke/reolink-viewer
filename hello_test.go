package hello

import "testing"

func TestGreeting(t *testing.T) {
	if got := Greeting("Ada"); got != "Hello, Ada!" {
		t.Errorf("Greeting(\"Ada\") = %q, want %q", got, "Hello, Ada!")
	}
}

func TestFarewell(t *testing.T) {
	if got := Farewell("Ada"); got != "Goodbye, Ada!" {
		t.Errorf("Farewell(\"Ada\") = %q, want %q", got, "Goodbye, Ada!")
	}
}
