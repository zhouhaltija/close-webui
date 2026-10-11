package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
)

type Cipher struct{ aead cipher.AEAD }

func NewCipher(base64key string) (*Cipher, error) {
	key, err := base64.StdEncoding.Strict().DecodeString(base64key)
	if err != nil || len(key) != 32 {
		return nil, errors.New("master key must be base64 encoded 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Encrypt(value, aad string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	data := c.aead.Seal(nonce, nonce, []byte(value), []byte(aad))
	return "v1:" + base64.StdEncoding.EncodeToString(data), nil
}

func (c *Cipher) Decrypt(value, aad string) (string, error) {
	if !strings.HasPrefix(value, "v1:") {
		return "", errors.New("unsupported ciphertext version")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(value, "v1:"))
	if err != nil || len(data) < c.aead.NonceSize()+c.aead.Overhead() {
		return "", errors.New("invalid ciphertext")
	}
	plain, err := c.aead.Open(nil, data[:c.aead.NonceSize()], data[c.aead.NonceSize():], []byte(aad))
	if err != nil {
		return "", errors.New("ciphertext authentication failed")
	}
	return string(plain), nil
}
