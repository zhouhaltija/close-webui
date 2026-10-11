package security

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type addressPolicy struct {
	allowed map[string]bool
	lookup  func(context.Context, string) ([]net.IPAddr, error)
}

func newPolicy(entries []string) (*addressPolicy, error) {
	p := &addressPolicy{allowed: make(map[string]bool), lookup: net.DefaultResolver.LookupIPAddr}
	for _, entry := range entries {
		host, port, err := net.SplitHostPort(entry)
		number, portErr := strconv.Atoi(port)
		if err != nil || portErr != nil || number < 1 || number > 65535 || host == "" || strings.ContainsAny(host, "/*@?#\\% ") {
			return nil, fmt.Errorf("invalid allowed upstream host:port %q", entry)
		}
		p.allowed[net.JoinHostPort(strings.ToLower(host), strconv.Itoa(number))] = true
	}
	return p, nil
}

func (p *addressPolicy) destination(u *url.URL) (string, error) {
	if u == nil || !u.IsAbs() || u.Host == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || strings.Contains(u.Host, "%") {
		return "", errors.New("invalid upstream URL")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", errors.New("upstream must use HTTPS")
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return "", errors.New("invalid upstream port")
	}
	destination := net.JoinHostPort(strings.ToLower(u.Hostname()), strconv.Itoa(number))
	if u.Scheme != "https" && !p.allowed[destination] {
		return "", errors.New("HTTP upstream is not explicitly allowed")
	}
	return destination, nil
}

func (p *addressPolicy) resolve(ctx context.Context, destination string) ([]net.IPAddr, error) {
	host, port, err := net.SplitHostPort(destination)
	if err != nil {
		return nil, err
	}
	destination = net.JoinHostPort(strings.ToLower(host), port)
	var ips []net.IPAddr
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IPAddr{{IP: ip}}
	} else {
		ips, err = p.lookup(ctx, host)
		if err != nil {
			return nil, errors.New("upstream DNS lookup failed")
		}
	}
	if len(ips) == 0 {
		return nil, errors.New("upstream DNS returned no addresses")
	}
	for _, ip := range ips {
		if ip.Zone != "" || ip.IP == nil {
			return nil, errors.New("invalid upstream address")
		}
		if !p.allowed[destination] && !publicIP(ip.IP) {
			return nil, errors.New("upstream resolves to a prohibited address")
		}
	}
	return ips, nil
}

var deniedPrefixes = func() []netip.Prefix {
	var ranges []netip.Prefix
	for _, prefix := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"} {
		ranges = append(ranges, netip.MustParsePrefix(prefix))
	}
	return ranges
}()

func publicIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	// IPv6 allocations outside the current global-unicast block include translation,
	// discard, unique-local and link-local address spaces.
	if address.Is6() && !netip.MustParsePrefix("2000::/3").Contains(address) {
		return false
	}
	for _, prefix := range deniedPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

// ValidateURL checks configuration now; the transport repeats DNS validation at
// every new connection and dials a checked IP to prevent rebinding.
func ValidateURL(raw string, allowedHosts []string) error {
	p, err := newPolicy(allowedHosts)
	if err != nil {
		return err
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid upstream URL")
	}
	destination, err := p.destination(u)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err = p.resolve(ctx, destination)
	return err
}

type safeRoundTripper struct {
	policy    *addressPolicy
	transport *http.Transport
}

func (t *safeRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if _, err := t.policy.destination(request.URL); err != nil {
		return nil, err
	}
	return t.transport.RoundTrip(request)
}

func NewHTTPClient(allowedHosts []string) (*http.Client, error) {
	p, err := newPolicy(allowedHosts)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil, ForceAttemptHTTP2: true, MaxIdleConns: 32, IdleConnTimeout: 60 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			ips, err := p.resolve(ctx, address)
			if err != nil {
				return nil, err
			}
			_, port, _ := net.SplitHostPort(address)
			var last error
			for _, ip := range ips {
				connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				if err == nil {
					return connection, nil
				}
				last = err
			}
			return nil, last
		},
	}
	return &http.Client{Transport: &safeRoundTripper{policy: p, transport: transport}, Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("upstream redirects are prohibited") }}, nil
}

// SafeTransport is retained as the security constructor used by HTTP callers.
func SafeTransport(allowedHosts []string) (*http.Client, error) { return NewHTTPClient(allowedHosts) }
