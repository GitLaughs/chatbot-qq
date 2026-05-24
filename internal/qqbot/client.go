package qqbot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	prodAPI    = "https://api.sgroup.qq.com"
	sandboxAPI = "https://sandbox.api.sgroup.qq.com"
	tokenAPI   = "https://bots.qq.com/app/getAppAccessToken"
)

type Client struct {
	AppID        string
	ClientSecret string
	Sandbox      bool
	HTTP         *http.Client
	token        string
}

type tokenRequest struct {
	AppID        string `json:"appId"`
	ClientSecret string `json:"clientSecret"`
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   string `json:"expires_in"`
}

type gatewayResponse struct {
	URL string `json:"url"`
}

type TextMessage struct {
	Content string `json:"content"`
	MsgID   string `json:"msg_id,omitempty"`
	MsgSeq  int    `json:"msg_seq,omitempty"`
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (c *Client) BaseURL() string {
	if c.Sandbox {
		return sandboxAPI
	}
	return prodAPI
}

func (c *Client) FetchAccessToken(ctx context.Context) (string, error) {
	reqBody, _ := json.Marshal(tokenRequest{
		AppID:        c.AppID,
		ClientSecret: c.ClientSecret,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenAPI, bytes.NewReader(reqBody))
	if err != nil {
		return "", fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch access token: %w", err)
	}
	defer resp.Body.Close()
	var out tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode access token: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("token endpoint returned %s", resp.Status)
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", fmt.Errorf("token endpoint returned empty access_token")
	}
	c.token = out.AccessToken
	return out.AccessToken, nil
}

func (c *Client) Gateway(ctx context.Context) (string, error) {
	var out gatewayResponse
	if err := c.getJSON(ctx, "/gateway", &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", fmt.Errorf("gateway endpoint returned empty url")
	}
	return out.URL, nil
}

func (c *Client) SendGroupText(ctx context.Context, groupOpenID, content, msgID string) error {
	path := "/v2/groups/" + groupOpenID + "/messages"
	return c.postJSON(ctx, path, TextMessage{Content: content, MsgID: msgID, MsgSeq: 1}, nil)
}

func (c *Client) SendUserText(ctx context.Context, userOpenID, content, msgID string) error {
	path := "/v2/users/" + userOpenID + "/messages"
	return c.postJSON(ctx, path, TextMessage{Content: content, MsgID: msgID, MsgSeq: 1}, nil)
}

func (c *Client) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL()+path, nil)
	if err != nil {
		return fmt.Errorf("build GET %s: %w", path, err)
	}
	c.authorize(req)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode GET %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("GET %s returned %s", path, resp.Status)
	}
	return nil
}

func (c *Client) postJSON(ctx context.Context, path string, in any, out any) error {
	reqBody, _ := json.Marshal(in)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL()+path, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("build POST %s: %w", path, err)
	}
	c.authorize(req)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close()
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("decode POST %s: %w", path, err)
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("POST %s returned %s", path, resp.Status)
	}
	return nil
}

func (c *Client) authorize(req *http.Request) {
	req.Header.Set("Authorization", "QQBot "+c.token)
}

