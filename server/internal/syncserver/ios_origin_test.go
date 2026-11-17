package syncserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestExactIOSOriginAndAuthenticatedSync(t *testing.T) {
	f := setup(t)
	for _, origin := range []string{"capacitor://localhost", "capacitor://evil", "capacitor://localhost.evil", "http://localhost"} {
		req, _ := http.NewRequest("OPTIONS", f.http.URL+"/user/info", nil)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		want := 403
		if origin == "capacitor://localhost" {
			want = 204
		}
		if resp.StatusCode != want {
			t.Fatalf("origin %s status %d", origin, resp.StatusCode)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, strings.Replace(f.http.URL, "http", "ws", 1)+"/sync", &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{"capacitor://localhost"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	send(t, c, map[string]any{"op": "init", "token": f.token, "id": f.vault.ID, "keyhash": f.vault.KeyHash, "encryption_version": 3, "initial": true})
	if read(t, c)["res"] != "ok" {
		t.Fatal("iOS login failed")
	}
	if read(t, c)["op"] != "ready" {
		t.Fatal("iOS ready missing")
	}
	req, _ := http.NewRequest("POST", f.http.URL+"/user/info", strings.NewReader(`{"token":"invalid"}`))
	req.Header.Set("Origin", "capacitor://localhost")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result map[string]any
	if err = json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result["error"] != "Not logged in" {
		t.Fatal("iOS Origin bypassed authentication")
	}
}
