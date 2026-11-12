package integration

import (
	"bufio"
	"net"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresAcceptsConnections(t *testing.T) {
	host := os.Getenv("PGHOST")
	if host == "" {
		t.Fatal("PGHOST is not set")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, "5432"), 5*time.Second)
	if err != nil {
		t.Fatalf("connect to Postgres: %v", err)
	}
	conn.Close()
}

func TestRedisAnswersPing(t *testing.T) {
	u, err := url.Parse(os.Getenv("REDIS_URL"))
	if err != nil || u.Host == "" {
		t.Fatalf("REDIS_URL is not a URL: %q", os.Getenv("REDIS_URL"))
	}
	conn, err := net.DialTimeout("tcp", u.Host, 5*time.Second)
	if err != nil {
		t.Fatalf("connect to Redis: %v", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte("PING\r\n")); err != nil {
		t.Fatalf("send PING: %v", err)
	}
	reply, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatalf("read reply: %v", err)
	}
	if strings.TrimSpace(reply) != "+PONG" {
		t.Fatalf("got %q, want +PONG", reply)
	}
}
