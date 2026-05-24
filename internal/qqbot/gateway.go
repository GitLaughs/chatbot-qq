package qqbot

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"ccconnect-qq/internal/adapter"

	"github.com/gorilla/websocket"
)

const (
	opDispatch  = 0
	opHeartbeat = 1
	opIdentify  = 2
	opHello     = 10
	opHeartbeatAck = 11
)

type Gateway struct {
	Client  *Client
	Intents int64
	OnMessage func(context.Context, adapter.Message)
}

type payload struct {
	Op int             `json:"op"`
	S  *int64          `json:"s,omitempty"`
	T  string          `json:"t,omitempty"`
	D  json.RawMessage `json:"d,omitempty"`
}

type helloData struct {
	HeartbeatInterval int `json:"heartbeat_interval"`
}

type identifyData struct {
	Token      string         `json:"token"`
	Intents    int64          `json:"intents"`
	Shard      []int          `json:"shard"`
	Properties map[string]any `json:"properties"`
}

type eventMessage struct {
	ID          string `json:"id"`
	Content     string `json:"content"`
	GroupOpenID string `json:"group_openid"`
	Author      struct {
		ID     string `json:"id"`
		UserID string `json:"user_openid"`
	} `json:"author"`
	Sender struct {
		UserOpenID string `json:"user_openid"`
	} `json:"sender"`
}

func (g *Gateway) Run(ctx context.Context) error {
	if g.Client == nil {
		return fmt.Errorf("gateway client is nil")
	}
	if _, err := g.Client.FetchAccessToken(ctx); err != nil {
		return err
	}
	gatewayURL, err := g.Client.Gateway(ctx)
	if err != nil {
		return err
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, gatewayURL, nil)
	if err != nil {
		return fmt.Errorf("dial gateway: %w", err)
	}
	defer conn.Close()

	var lastSeq *int64
	for {
		var p payload
		if err := conn.ReadJSON(&p); err != nil {
			return fmt.Errorf("read gateway payload: %w", err)
		}
		if p.S != nil {
			lastSeq = p.S
		}
		switch p.Op {
		case opHello:
			var h helloData
			if err := json.Unmarshal(p.D, &h); err != nil {
				return fmt.Errorf("decode hello: %w", err)
			}
			if h.HeartbeatInterval <= 0 {
				h.HeartbeatInterval = 45000
			}
			go heartbeat(ctx, conn, time.Duration(h.HeartbeatInterval)*time.Millisecond, &lastSeq)
			if err := conn.WriteJSON(payload{Op: opIdentify, D: mustJSON(identifyData{
				Token:   "QQBot " + g.Client.token,
				Intents: g.Intents,
				Shard:   []int{0, 1},
				Properties: map[string]any{
					"os":      "windows",
					"browser": "ccconnect-qq",
					"device":  "ccconnect-qq",
				},
			})}); err != nil {
				return fmt.Errorf("send identify: %w", err)
			}
		case opDispatch:
			g.handleDispatch(ctx, p)
		case opHeartbeatAck:
			slog.Debug("qqbot heartbeat ack")
		default:
			slog.Debug("qqbot gateway op ignored", "op", p.Op, "type", p.T)
		}
	}
}

func heartbeat(ctx context.Context, conn *websocket.Conn, every time.Duration, lastSeq **int64) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var seq any
			if lastSeq != nil && *lastSeq != nil {
				seq = **lastSeq
			}
			if err := conn.WriteJSON(payload{Op: opHeartbeat, D: mustJSON(seq)}); err != nil {
				slog.Warn("qqbot heartbeat failed", "error", err)
				return
			}
		}
	}
}

func (g *Gateway) handleDispatch(ctx context.Context, p payload) {
	var m eventMessage
	if err := json.Unmarshal(p.D, &m); err != nil {
		slog.Debug("qqbot dispatch decode skipped", "type", p.T, "error", err)
		return
	}
	userID := firstNonEmpty(m.Author.UserID, m.Author.ID, m.Sender.UserOpenID)
	msg := adapter.Message{
		Platform:  "qqbot",
		EventType: p.T,
		GroupID:   m.GroupOpenID,
		UserID:    userID,
		MessageID: m.ID,
		Content:   strings.TrimSpace(m.Content),
		RawType:   p.T,
	}
	if msg.GroupID != "" {
		msg.SessionKey = "qqbot:group:" + msg.GroupID
	} else if msg.UserID != "" {
		msg.SessionKey = "qqbot:c2c:" + msg.UserID
	}
	if msg.SessionKey == "" || msg.Content == "" {
		return
	}
	if g.OnMessage != nil {
		g.OnMessage(ctx, msg)
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
