package security

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPasswordRejectsWrongOrMalformedCredentials(t *testing.T) {
	hash, err := HashPassword("正确的密码123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") || !VerifyPassword("正确的密码123", hash) {
		t.Fatal("password did not round trip through Argon2id")
	}
	if VerifyPassword("wrong", hash) {
		t.Fatal("accepted wrong password")
	}
	for _, bad := range []string{"", "plain", "$argon2id$v=19$m=4294967295,t=3,p=2$YQ$YQ", strings.Replace(hash, "v=19", "v=18", 1)} {
		if VerifyPassword("正确的密码123", bad) {
			t.Fatal("accepted malformed hash")
		}
	}
	if _, err := HashPassword(""); err == nil {
		t.Fatal("accepted empty password")
	}
}

func TestCipherAuthenticatesKeyAADAndCiphertext(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))
	c, err := NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := c.Encrypt("secret-key", "user/provider")
	if err != nil {
		t.Fatal(err)
	}
	second, _ := c.Encrypt("secret-key", "user/provider")
	if encrypted == second || strings.Contains(encrypted, "secret-key") {
		t.Fatal("nonce reused or plaintext leaked")
	}
	value, err := c.Decrypt(encrypted, "user/provider")
	if err != nil || value != "secret-key" {
		t.Fatalf("decrypt: %q %v", value, err)
	}
	wrong, _ := NewCipher(base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32))))
	for _, check := range []struct {
		cipher    *Cipher
		text, aad string
	}{{c, encrypted, "other/provider"}, {wrong, encrypted, "user/provider"}, {c, encrypted[:len(encrypted)-2] + "xx", "user/provider"}, {c, "v1:AA==", "user/provider"}} {
		if _, err := check.cipher.Decrypt(check.text, check.aad); err == nil {
			t.Fatal("accepted unauthenticated ciphertext")
		}
	}
	for _, bad := range []string{"", "not-base64", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if _, err := NewCipher(bad); err == nil {
			t.Fatal("accepted invalid master key")
		}
	}
}

func TestTokensAreRandomAndOnlyDigestIsStored(t *testing.T) {
	a, err := RandomToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := RandomToken()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(a)
	if err != nil || len(decoded) != 32 || a == b {
		t.Fatal("invalid random token")
	}
	if got := HashToken("abc"); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("wrong SHA-256: %s", got)
	}
}

func TestURLAndAddressRulesRejectPrivateAndSpecialDestinations(t *testing.T) {
	for _, raw := range []string{"http://example.com", "https://127.0.0.1", "https://[::ffff:127.0.0.1]", "https://169.254.169.254", "https://100.64.0.1", "https://192.0.2.1", "https://198.19.0.1", "https://203.0.113.1", "https://[2001:db8::1]", "https://[2002:7f00:1::]", "https://user:secret@8.8.8.8", "file:///tmp", "https://8.8.8.8/#fragment"} {
		if err := ValidateURL(raw, nil); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if err := ValidateURL("https://8.8.8.8/v1", nil); err != nil {
		t.Fatal(err)
	}
	if err := ValidateURL("http://127.0.0.1:1234/v1", []string{"127.0.0.1:1234"}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateURL("http://127.0.0.1:1235", []string{"127.0.0.1:1234"}); err == nil {
		t.Fatal("allowlist did not constrain port")
	}
	for _, bad := range []string{"*", "localhost", "http://localhost:1234", "localhost:*"} {
		if _, err := NewHTTPClient([]string{bad}); err == nil {
			t.Fatalf("accepted allowlist %s", bad)
		}
	}
}

func TestDNSRebindingChecksEveryResolvedAddressBeforeDial(t *testing.T) {
	p, err := newPolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	p.lookup = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
	}
	if _, err := p.resolve(context.Background(), "example.com:443"); err == nil {
		t.Fatal("accepted mixed public/private DNS answer")
	}
	p.lookup = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	if _, err := p.resolve(context.Background(), "example.com:443"); err != nil {
		t.Fatal(err)
	}
}

func TestAllowedLocalRequestCannotRedirectOrUseProxy(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("redirect target called") }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	t.Setenv("HTTP_PROXY", target.URL)
	t.Setenv("HTTPS_PROXY", target.URL)
	client, err := NewHTTPClient([]string{strings.TrimPrefix(server.URL, "http://")})
	if err != nil {
		t.Fatal(err)
	}
	if response, err := client.Get(server.URL); err == nil {
		response.Body.Close()
		t.Fatal("followed or accepted redirect")
	}
	if _, err := client.Get(target.URL); err == nil {
		t.Fatal("allowed request to unlisted local destination")
	}
}

func TestAllowedHostnameComparisonIsCaseInsensitiveAtDial(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer server.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	client, err := NewHTTPClient([]string{"localhost:" + port})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get("http://LOCALHOST:" + port)
	if err != nil {
		t.Fatalf("allowed hostname failed at dial: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatal("did not reach allowed server")
	}
}
