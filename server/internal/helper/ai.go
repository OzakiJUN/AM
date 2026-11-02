package helper

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Model is the OpenAI-compatible model the bot's features share ([helper]
// ai_url / ai_key / ai_model / ai_proxy). URL "" = none.
type Model struct {
	URL, Key, Name, Proxy string
}

// ErrNoModel: no model is set up.
var ErrNoModel = errors.New("没配置模型")

// SetModel sets the shared model (at startup).
func (s *Service) SetModel(m Model) { s.model = m }

// HasModel: a model is set up.
func (s *Service) HasModel() bool { return s.model.URL != "" }

// Ask sends one chat request and returns the answer's text.
func (s *Service) Ask(ctx context.Context, system, user string, maxTokens int, temperature float64) (string, error) {
	m := s.model
	if m.URL == "" {
		return "", ErrNoModel
	}
	body, _ := json.Marshal(map[string]any{
		"model": m.Name, "stream": false, "temperature": temperature, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.URL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if m.Key != "" {
		req.Header.Set("Authorization", "Bearer "+m.Key)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if p := strings.TrimSpace(m.Proxy); p != "" {
		u, err := url.Parse(p)
		if err != nil {
			return "", fmt.Errorf("代理地址不对：%s", p)
		}
		tr.Proxy = http.ProxyURL(u)
	}
	res, err := (&http.Client{Transport: tr, Timeout: 2 * time.Minute}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("模型 HTTP %d", res.StatusCode)
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(b, &r); err != nil || len(r.Choices) == 0 {
		return "", errors.New("模型的回答看不懂")
	}
	return strings.TrimSpace(r.Choices[0].Message.Content), nil
}
