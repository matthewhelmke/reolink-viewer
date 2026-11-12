// Package hello builds greetings.
package hello

// Greeting returns a greeting for name.
func Greeting(name string) string {
	return "Hello, " + name + "!"
}

// Farewell returns a farewell for name.
func Farewell(name string) string {
	return "Goodbye, " + name + "!"
}
